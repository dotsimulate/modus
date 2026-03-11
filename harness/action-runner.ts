/**
 * Action Runner — orchestrates automated agent sessions (with multipart content support).
 *
 * Actions are the automation primitive in MO:
 *   trigger → gather() → session → afterRun()
 *
 * Each action is a directory: actions/<name>/ containing:
 *   - action.json  → ActionConfig (trigger, agent profile ref, limits)
 *   - context.ts   → ActionModule (gather function + optional afterRun hook)
 *
 * Trigger types:
 *   - interval   → tick loop checks every 10s
 *   - webhook    → HTTP POST with token auth
 *   - manual     → UI button / API call
 *   - action     → fires after another action completes (chain)
 *
 * Executions: each lifecycle instance (start → runs → exhaust) is tracked as
 * a first-class entity. An action can have multiple concurrent executions
 * (controlled by `concurrency` config). Run/cycle counters are per-execution.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";
import { getAllUserProfiles } from "./profiles";
import { startSession, getActiveSession, switchProfile, queueMessage, type ActiveSession } from "./session-manager";
import {
  insertActionRun, updateActionRun, getActionRuns as dbGetActionRuns,
  getRunSummaries as dbGetRunSummaries, getNextRunNumber, getSession,
  listSessions, getEvents, searchSessions,
  insertExecution, updateExecution as dbUpdateExecution,
  updateSessionTitle, addSessionTag, removeSessionTag,
} from "./db";
import type { SessionRow, EventRow, SearchHit } from "./db";
import type {
  ActionConfig, ActionContext, ActionModule, ActionContent, RunResult,
  ActionState, ExecutionState, ActionDB, TriggerInfo, SessionOutcome,
  SessionInfo, SearchResult, EventInfo,
  SessionTriggerEvent, SessionTriggerPayload,
} from "./action-types";
import { MAX_CHAIN_DEPTH } from "./action-types";
import { sendNotifications, sendActionNotification } from "./notify";
import { logActivity, getActivityLog, getActivitySummary } from "./activity";
import { svgToPngBase64 } from "./svg-render";

// ── Constants ──

const ACTIONS_DIR = join(import.meta.dir, "actions");
const MODUS_ACTIONS = ".modus/actions";
const TICK_INTERVAL_MS = 10_000;       // check every 10 seconds
const SESSION_TIMEOUT_MS = 30 * 60_000; // 30 minute max per run
const POLL_INTERVAL_MS = 2_000;        // poll session status every 2s

// ── Mime → Extension ──

const MIME_EXTENSIONS: Record<string, string> = {
  "image/svg+xml": ".svg",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
};

function mimeToExtension(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? `.${mime.split("/").pop() ?? "bin"}`;
}

// ── State ──

const actionStates = new Map<string, ActionState>();
let tickInterval: ReturnType<typeof setInterval> | null = null;

// ── Interval Parsing ──

function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)(s|m|h|d)$/);
  if (match) {
    const n = parseInt(match[1]!);
    const unit = match[2]! as keyof typeof multipliers;
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return n * multipliers[unit];
  }
  const ms = parseInt(interval);
  if (!isNaN(ms) && ms > 0) return ms;
  throw new Error(`Invalid interval: "${interval}" — use "30s", "5m", "1h", etc.`);
}

// ── Active Hours (interval triggers only) ──

function isWithinActiveHours(activeHours?: { start: string; end: string }): boolean {
  if (!activeHours) return true;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH = 0, startM = 0] = activeHours.start.split(":").map(Number);
  const [endH = 0, endM = 0] = activeHours.end.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  if (start <= end) return currentMinutes >= start && currentMinutes < end;
  // Wraps midnight (e.g., 22:00 - 06:00)
  return currentMinutes >= start || currentMinutes < end;
}

// ── Execution Helpers ──

/** Check if an execution has exhausted its run/cycle budget */
function isExecutionExhausted(exec: ExecutionState, config: ActionConfig): boolean {
  const { maxRuns, maxCycles, cycleInterval } = config;
  if (!maxRuns || maxRuns <= 0) return false;
  if (cycleInterval && maxCycles && maxCycles > 0) {
    return exec.cycleNumber >= maxCycles && exec.cycleRunCount >= maxRuns;
  }
  // Lifetime cap: total runs across all cycles
  return exec.runNumber >= maxRuns;
}

/** Find the first active execution for an action, or null */
function findActiveExecution(state: ActionState): ExecutionState | null {
  for (const exec of state.activeExecutions.values()) {
    if (exec.status === "running") return exec;
  }
  return null;
}

/** Create a new execution in DB and return in-memory state */
function createExecution(actionName: string, config: ActionConfig): ExecutionState {
  const id = insertExecution(actionName, JSON.stringify(config));
  return {
    id,
    actionName,
    status: "running",
    startedAt: Date.now(),
    runNumber: 0,
    cycleNumber: 1,
    cycleRunCount: 0,
    cycleStartedAt: null,
    currentSessionId: null,
    lastStatus: null,
    totalCostUsd: 0,
    transientAttempts: 0,
  };
}

/** Close an execution (mark done in DB and memory) */
function closeExecution(exec: ExecutionState, state: ActionState): void {
  exec.status = "done";
  dbUpdateExecution(exec.id, {
    status: "done",
    completedAt: Date.now(),
    runCount: exec.runNumber,
    cycleCount: exec.cycleNumber,
    totalCostUsd: exec.totalCostUsd,
  });
  state.activeExecutions.delete(exec.id);
}

/** Handle what happens when an execution exhausts its budget */
function handleOnExhausted(state: ActionState): void {
  const mode = state.config.onExhausted ?? "archive";

  // Notify on exhaustion
  if (state.config.notify?.length) {
    sendActionNotification(state.config.notify, "exhausted", {
      actionName: state.config.name, profile: state.config.agentProfile,
    }).catch(err => console.error(`[actions] Exhaustion notification error:`, err));
  }

  switch (mode) {
    case "archive":
      state.exhausted = true;
      setActionEnabled(state.config.name, false);
      break;
    case "idle":
      state.nextRunAt = null;
      break;
    case "restart": {
      const exec = createExecution(state.config.name, state.config);
      state.activeExecutions.set(exec.id, exec);
      break;
    }
  }
}

// ── Exhaustion Detection (for loading from DB) ──

function deriveExhausted(config: ActionConfig, runCount: number, cycle: number, cycleRunCount: number): boolean {
  if (config.enabled) return false;
  const { maxRuns, maxCycles, cycleInterval } = config;
  if (!maxRuns || maxRuns <= 0) return false;
  if (cycleInterval && maxCycles && maxCycles > 0) {
    return cycle >= maxCycles && cycleRunCount >= maxRuns;
  }
  return runCount >= maxRuns;
}

// ── Project-local action discovery ──

/** Collect all .modus/actions/ directories from known user-profile project paths */
function discoverProjectActionDirs(): Array<{ actionsDir: string; projectCwd: string }> {
  const result: Array<{ actionsDir: string; projectCwd: string }> = [];
  const userProfiles = getAllUserProfiles();
  const seen = new Set<string>();
  for (const up of Object.values(userProfiles)) {
    for (const proj of up.projects ?? []) {
      if (seen.has(proj)) continue;
      seen.add(proj);
      const dir = join(proj, MODUS_ACTIONS);
      if (existsSync(dir)) result.push({ actionsDir: dir, projectCwd: proj });
    }
  }
  return result;
}

// ── Action Loading ──

function loadActionsFromDir(actionsDir: string, defaultCwd?: string): void {
  if (!existsSync(actionsDir)) return;
  const dirs = readdirSync(actionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    const configPath = join(actionsDir, name, "action.json");
    if (!existsSync(configPath)) continue;
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as ActionConfig;
      config.name = name;
      // Project-local actions default their CWD to the project they came from
      if (defaultCwd && !config.cwd) config.cwd = defaultCwd;

      if (config.trigger.type === "interval") {
        parseInterval(config.trigger.every);
      }

      if (config.trigger.type === "webhook" && !config.trigger.token) {
        config.trigger.token = crypto.randomUUID();
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log(`[actions] Generated webhook token for "${name}"`);
      }

      const existing = actionStates.get(name);
      const lastRunNumber = getNextRunNumber(name) - 1;
      const lastRuns = dbGetActionRuns(name, 1);
      const lastRun = lastRuns[0];

      // Determine cycle state from DB
      let currentCycle = lastRun?.cycleNumber ?? 1;
      const recentRuns = dbGetActionRuns(name, 100);
      let cycleRunCount = recentRuns.filter(r => r.cycleNumber === currentCycle).length;

      if (config.cycleInterval && config.maxRuns && cycleRunCount >= config.maxRuns) {
        currentCycle++;
        cycleRunCount = 0;
      }

      const nextRunAt = existing ? existing.nextRunAt
        : config.enabled && config.trigger.type === "interval"
          ? Date.now() + parseInterval(config.trigger.every)
          : null;

      const actionDir = join(actionsDir, name);
      const isRunning = existing && existing.activeExecutions.size > 0;
      if (isRunning) {
        existing.config = config;
        existing.actionDir = actionDir;
      } else {
        const state: ActionState = existing ?? {
          config,
          actionDir,
          activeExecutions: new Map(),
          lastRunAt: null,
          nextRunAt: null,
          exhausted: false,
        };
        Object.assign(state, {
          config,
          actionDir,
          lastRunAt: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
          nextRunAt,
          exhausted: deriveExhausted(config, lastRunNumber, currentCycle, cycleRunCount),
        });
        if (!existing) {
          state.activeExecutions = new Map();
          actionStates.set(name, state);
        }
      }
    } catch (err) {
      console.error(`[actions] Failed to load action "${name}":`, err);
    }
  }
}

function loadActions(): void {
  loadActionsFromDir(ACTIONS_DIR);
  for (const { actionsDir, projectCwd } of discoverProjectActionDirs()) {
    loadActionsFromDir(actionsDir, projectCwd);
  }
}

// ── Session Monitoring ──

async function monitorSession(
  session: ActiveSession,
  actionName: string,
): Promise<SessionOutcome> {
  const start = Date.now();
  let pollCount = 0;

  while (Date.now() - start < SESSION_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    pollCount++;

    // Read status directly from the live object — immune to rekey ID changes
    const status = session.status;
    const currentId = session.sessionId;

    if (pollCount <= 5 || pollCount % 10 === 0) {
      console.log(`[actions:monitor] "${actionName}" poll #${pollCount}: status=${status} id=${currentId.slice(0, 20)}`);
    }

    if (status === "idle" || status === "done" || status === "error") {
      const dbSession = getSession(currentId);
      const sessionStatus = status === "error" ? "error" as const : "done" as const;
      console.log(`[actions] Session completed for "${actionName}": ${status}`);
      return {
        sessionStatus,
        response: dbSession?.last_response ?? null,
        summary: dbSession?.last_response?.slice(0, 500) ?? null,
        costUsd: session.costUsd,
        error: status === "error" ? (session.error ?? "unknown error") : null,
      };
    }
  }

  console.error(`[actions] Session timed out for "${actionName}" after ${SESSION_TIMEOUT_MS / 60000}m`);
  return {
    sessionStatus: "timeout",
    response: null,
    summary: null,
    costUsd: 0,
    error: `timeout after ${SESSION_TIMEOUT_MS / 60000} minutes`,
  };
}

// ── Transient Error Detection ──

const TRANSIENT_PATTERNS = [
  "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET",
  "fetch failed", "network", "socket hang up",
  "503", "502", "429",
  "timeout", "EHOSTUNREACH",
];

function isTransientError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  return TRANSIENT_PATTERNS.some(p => msg.includes(p.toLowerCase()));
}

// ── DB Row Mappers ──

function mapSession(r: SessionRow): SessionInfo {
  return {
    id: r.id, preview: r.preview, profile: r.profile, model: r.model,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at, messageCount: r.message_count,
    totalCostUsd: r.total_cost_usd, lastPrompt: r.last_prompt,
    lastResponse: r.last_response, cwd: r.cwd, actionName: r.action_name,
  };
}

function mapSearchHit(r: SearchHit): SearchResult {
  return {
    sessionId: r.session_id, preview: r.preview, profile: r.profile,
    model: r.model, cwd: r.cwd, lastMessageAt: r.last_message_at,
    totalCostUsd: r.total_cost_usd, snippet: r.snippet,
  };
}

function mapEvent(r: EventRow): EventInfo {
  return {
    id: r.id, sessionId: r.session_id, seq: r.seq, type: r.type,
    subtype: r.subtype, data: r.data, createdAt: r.created_at,
  };
}

function buildActionDB(actionName: string): ActionDB {
  return {
    getRunSummaries: (limit = 20) => dbGetRunSummaries(actionName, limit),
    getRunHistory: (limit = 20) => dbGetActionRuns(actionName, limit),
    getActionRuns: (name, limit = 20) => dbGetActionRuns(name, limit),
    listSessions: (limit = 50) => listSessions(limit).map(mapSession),
    getSession: (id) => { const s = getSession(id); return s ? mapSession(s) : null; },
    searchSessions: (query, limit = 20) => searchSessions(query, limit).map(mapSearchHit),
    getEvents: (sessionId, afterSeq = 0) => getEvents(sessionId, afterSeq).map(mapEvent),
    updateSessionTitle,
    addSessionTag,
    removeSessionTag,
    getActivityLog,
    getActivitySummary,
  };
}

// ── Core: Fire an Action ──

async function fireAction(
  name: string,
  triggerInfo: TriggerInfo,
  chainDepth: number = 0,
  overrides?: { userProfile?: string },
): Promise<void> {
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    console.error(`[actions] Chain depth limit (${MAX_CHAIN_DEPTH}) reached — refusing to fire "${name}"`);
    return;
  }

  const state = actionStates.get(name);
  if (!state) {
    console.error(`[actions] Unknown action "${name}" — skipping`);
    return;
  }

  // Concurrency guard
  const maxConcurrency = state.config.concurrency ?? 1;
  if (state.activeExecutions.size >= maxConcurrency) {
    console.log(`[actions] "${name}" at concurrency limit (${maxConcurrency}) — dropping ${triggerInfo.type} trigger`);
    return;
  }

  // Find or create execution
  let exec = findActiveExecution(state);
  if (!exec) {
    exec = createExecution(name, state.config);
    state.activeExecutions.set(exec.id, exec);
  }

  const runStartedAt = Date.now();
  const runNumber = getNextRunNumber(name);
  exec.runNumber++;
  const execRunNumber = exec.runNumber; // per-execution run number
  const cfg = state.config;
  const effectiveUserProfile = overrides?.userProfile ?? cfg.userProfile;
  const actionDir = state.actionDir;

  // Start cycle clock on first run of a cycle
  if (!exec.cycleStartedAt) {
    exec.cycleStartedAt = Date.now();
  }

  console.log(`[actions] Starting run #${runNumber} (exec #${exec.id}, cycle #${exec.cycleNumber}, run ${exec.cycleRunCount + 1}/${cfg.maxRuns ?? "∞"}) for "${name}" [${triggerInfo.type}]`);

  logActivity({
    eventType: "action_trigger",
    actionName: name,
    agentProfile: cfg.agentProfile,
    userProfile: effectiveUserProfile,
    summary: `Action "${name}" triggered (${triggerInfo.type})`,
    metadata: { triggerType: triggerInfo.type, runNumber, executionId: exec.id },
  });

  let runId: number | null = null;
  let runResult: RunResult | null = null;
  let isTransient = false;

  try {
    const contextPath = join(actionDir, "context.ts");
    if (!existsSync(contextPath)) {
      throw new Error(`Missing context.ts for action "${name}"`);
    }
    const mod: ActionModule = await import(`${contextPath}?t=${Date.now()}`);
    if (typeof mod.gather !== "function") {
      throw new Error(`context.ts for "${name}" does not export a gather() function`);
    }

    const startedAt = Date.now();
    runId = insertActionRun(name, runNumber, null, startedAt, exec.cycleNumber, triggerInfo.type, effectiveUserProfile, exec.id);

    const maxRetries = cfg.maxRetries ?? 0;
    let attempt = 1;
    let lastVerifyError: string | undefined;
    let lastCtx: ActionContext | null = null;

    // ── Verify retry loop ──
    for (attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const runDir = join(actionDir, "output", `exec-${exec.id}`, `run-${execRunNumber}`);
      let artifactDirCreated = false;

      const db = buildActionDB(name);
      const totalSteps = (cfg.steps?.length ?? 0) + 1;
      const ctx: ActionContext = {
        actionName: name,
        executionId: exec.id,
        runNumber,
        cycleNumber: exec.cycleNumber,
        cycleRunIndex: exec.cycleRunCount,
        lastRunAt: state.lastRunAt ? new Date(state.lastRunAt) : null,
        db,
        trigger: triggerInfo,
        actionDir,
        stepIndex: 0,
        totalSteps,
        previousStepResult: null,
        attempt,
        lastVerifyError,
        log(message: string, metadata?: Record<string, unknown>) {
          const combined = { ...metadata, runNumber, executionId: exec.id, attempt };
          logActivity({
            eventType: "action_log",
            actionName: name,
            agentProfile: cfg.agentProfile,
            userProfile: effectiveUserProfile,
            summary: `[${name}] ${message}`,
            metadata: combined,
          });
          console.log(`[actions:${name}] ${message}`);
        },
        artifactDir() {
          if (!artifactDirCreated) {
            mkdirSync(runDir, { recursive: true });
            artifactDirCreated = true;
          }
          return runDir;
        },
        artifactPath(filename: string) {
          return join(ctx.artifactDir(), filename);
        },
        artifact(artifactName: string) {
          const spec = cfg.artifacts?.find(a => a.name === artifactName);
          if (!spec) throw new Error(`No artifact "${artifactName}" declared in action.json for "${name}"`);
          return join(ctx.artifactDir(), artifactName + mimeToExtension(spec.mime));
        },
        svgToPngBase64,
      };
      lastCtx = ctx;

      if (attempt > 1) {
        console.log(`[actions] Retry attempt ${attempt}/${maxRetries + 1} for "${name}" run #${runNumber} (last error: ${lastVerifyError})`);
      }

      let prompt: string | ActionContent;
      try {
        const gathered = await mod.gather(ctx);
        if (!gathered || (typeof gathered !== "string" && !Array.isArray(gathered))) {
          throw new Error(`gather() returned invalid prompt for "${name}": ${typeof gathered}`);
        }
        prompt = gathered;
      } catch (gatherErr: any) {
        const stderr = gatherErr?.stderr ? String(gatherErr.stderr).trim() : "";
        const baseMsg = String(gatherErr?.message ?? gatherErr);
        const gatherErrMsg = stderr ? `${baseMsg}: ${stderr}` : baseMsg;

        if ((cfg.onGatherError ?? "fail") === "retry" && attempt < maxRetries + 1) {
          lastVerifyError = `gather error: ${gatherErrMsg}`;
          console.log(`[actions] gather() failed for "${name}" run #${runNumber} attempt ${attempt}: ${gatherErrMsg} — retrying`);
          continue;
        }
        throw gatherErr;
      }

      const session = startSession({
        prompt,
        profile: cfg.agentProfile,
        provider: cfg.provider,
        maxTurns: cfg.maxTurns,
        model: cfg.model,
        effort: cfg.effort,
        cwd: cfg.cwd,
        tools: cfg.tools,
        disallowedTools: cfg.disallowedTools,
        loadProjectSettings: cfg.loadProjectSettings,
        actionName: name,
        userProfile: effectiveUserProfile,
      });

      const idStart = Date.now();
      while (session.sessionId.startsWith("pending-") && Date.now() - idStart < 15_000) {
        await new Promise(r => setTimeout(r, 200));
      }

      exec.currentSessionId = session.sessionId;
      console.log(`[actions] Run #${runNumber} for "${name}" → session ${session.sessionId} (attempt ${attempt})`);

      updateActionRun(runId, {
        sessionId: session.sessionId,
        status: "running",
        attempts: attempt,
      });

      const attemptStart = Date.now();
      console.log(`[actions:${name}] monitorSession START for ${session.sessionId}`);
      const outcome = await monitorSession(session, name);
      console.log(`[actions:${name}] monitorSession END: ${outcome.sessionStatus} (${Date.now() - attemptStart}ms)`);

      const outcomeStatus: RunResult["status"] =
        outcome.sessionStatus === "error" || outcome.sessionStatus === "timeout"
          ? "error" : "done";

      runResult = {
        status: outcomeStatus,
        response: outcome.response,
        summary: outcome.summary,
        costUsd: outcome.costUsd,
        durationMs: Date.now() - attemptStart,
        sessionId: session.sessionId,
        error: outcome.error,
      };

      // ── Multi-step sequence ──
      if (outcomeStatus !== "error" && cfg.steps?.length) {
        let finalOutcome = outcome;

        for (let si = 0; si < cfg.steps.length; si++) {
          const step = cfg.steps[si]!;
          const stepIndex = si + 1;

          // 1. Switch profile
          const switched = await switchProfile(session.sessionId, step.profile, {
            contextMode: step.contextMode ?? "full",
          });
          if (!switched) {
            runResult!.status = "error";
            runResult!.error = `switch to "${step.profile}" failed`;
            break;
          }

          // 2. Get prompt for this step
          let stepPrompt: string | ActionContent;
          if (step.prompt) {
            stepPrompt = step.prompt;
          } else {
            const stepCtx = { ...ctx, stepIndex, previousStepResult: finalOutcome };
            stepPrompt = await mod.gather(stepCtx);
          }

          // 3. Queue message (status set to "starting" by queueMessage)
          const promptStr = typeof stepPrompt === "string" ? stepPrompt : JSON.stringify(stepPrompt);
          queueMessage(session.sessionId, promptStr);

          // 4. Wait for step completion
          finalOutcome = await monitorSession(session, name);

          // Accumulate cost
          runResult!.costUsd += finalOutcome.costUsd;

          if (finalOutcome.sessionStatus === "error" || finalOutcome.sessionStatus === "timeout") {
            runResult!.status = "error";
            runResult!.error = finalOutcome.error;
            break;
          }
        }

        // Update runResult with final step's outcome
        runResult!.response = finalOutcome.response;
        runResult!.summary = finalOutcome.summary;
        if (runResult!.status !== "error") {
          runResult!.status = "done";
        }
      }

      if (runResult!.status === "error") break;

      if (typeof mod.verify === "function") {
        try {
          const verifyResult = await mod.verify(ctx, runResult);
          if (verifyResult.ok) break;

          lastVerifyError = verifyResult.reason;
          console.log(`[actions] Verify failed for "${name}" run #${runNumber} attempt ${attempt}: ${verifyResult.reason}`);

          if (!verifyResult.retry || attempt >= maxRetries + 1) {
            runResult.status = "failed-verification";
            runResult.error = lastVerifyError;
            break;
          }
          continue;
        } catch (verifyErr: any) {
          lastVerifyError = String(verifyErr?.message ?? verifyErr);
          console.error(`[actions] verify() threw for "${name}" run #${runNumber}:`, verifyErr);
          runResult.status = "failed-verification";
          runResult.error = lastVerifyError;
          break;
        }
      } else if (cfg.artifacts?.length) {
        // ── Auto-verify from artifact specs ──
        const missing: string[] = [];
        for (const spec of cfg.artifacts) {
          if (spec.required === false) continue;
          const path = join(ctx.artifactDir(), spec.name + mimeToExtension(spec.mime));
          if (!existsSync(path)) {
            missing.push(`"${spec.name}" not found at ${path}`);
          } else {
            try {
              const size = statSync(path).size;
              if (size === 0) missing.push(`"${spec.name}" is empty (0 bytes)`);
            } catch { missing.push(`"${spec.name}" stat failed`); }
          }
        }

        if (missing.length === 0) break;

        lastVerifyError = `Missing artifacts: ${missing.join("; ")}`;
        console.log(`[actions] Auto-verify failed for "${name}" run #${runNumber} attempt ${attempt}: ${lastVerifyError}`);

        if (attempt >= maxRetries + 1) {
          runResult.status = "failed-verification";
          runResult.error = lastVerifyError;
          break;
        }
        continue;
      } else {
        break;
      }
    }

    if (attempt > maxRetries + 1 && runResult && runResult.status === "done") {
      runResult.status = "failed-verification";
      runResult.error = lastVerifyError ?? "verify retries exhausted";
    }

    const finalStatus = runResult!.status;
    exec.lastStatus = finalStatus;
    const finalAttempts = Math.min(attempt, maxRetries + 1);

    updateActionRun(runId, {
      status: finalStatus,
      summary: runResult!.summary ?? undefined,
      completedAt: Date.now(),
      costUsd: runResult!.costUsd,
      error: runResult!.error ?? undefined,
      verifyError: lastVerifyError,
      attempts: finalAttempts,
    });

    console.log(`[actions] Run #${runNumber} finalized for "${name}": ${finalStatus} (${finalAttempts} attempt(s))`);

    if (finalStatus === "done" && typeof mod.afterRun === "function" && lastCtx) {
      try {
        await mod.afterRun(lastCtx, runResult!);
        console.log(`[actions] afterRun completed for "${name}" run #${runNumber}`);
      } catch (hookErr: any) {
        const afterRunError = String(hookErr?.message ?? hookErr);
        console.error(`[actions] afterRun failed for "${name}" run #${runNumber}:`, hookErr);
        updateActionRun(runId, { afterRunError });
      }
    }

    // Notifications (after afterRun, before chain triggers)
    if (cfg.notify?.length) {
      sendNotifications(cfg.notify, runResult!, {
        actionName: name, runNumber, profile: cfg.agentProfile,
      }).catch(err => console.error(`[actions] Notification error for "${name}":`, err));
    }

  } catch (err: any) {
    const stderr = err?.stderr ? String(err.stderr).trim() : "";
    const baseMsg = String(err?.message ?? err);
    const errMsg = stderr ? `${baseMsg}: ${stderr}` : baseMsg;
    isTransient = isTransientError(err);

    if (isTransient && (cfg.onTransientFailure ?? "retry") === "retry") {
      const maxTR = cfg.maxTransientRetries ?? 2;
      const bkoff = cfg.retryBackoff ? parseInterval(cfg.retryBackoff) : 120_000;
      const ta = exec.transientAttempts + 1;
      exec.transientAttempts = ta;

      if (ta <= maxTR) {
        console.log(`[actions] Transient error for "${name}" run #${runNumber} (${ta}/${maxTR}): ${errMsg} — retrying in ${bkoff / 1000}s`);
        if (runId !== null) {
          updateActionRun(runId, {
            status: "error",
            error: `transient (attempt ${ta}): ${errMsg}`,
            completedAt: Date.now(),
          });
        }
        exec.currentSessionId = null;
        await new Promise(r => setTimeout(r, bkoff));
        return fireAction(name, triggerInfo, chainDepth, overrides);
      }
      console.error(`[actions] Transient retries exhausted for "${name}" run #${runNumber} after ${ta} attempts`);
    }

    console.error(`[actions] Run #${runNumber} failed for "${name}":`, err);
    exec.lastStatus = isTransient ? "error-transient" : "error";
    runResult = {
      status: isTransient ? "error-transient" : "error",
      response: null, summary: null, costUsd: 0, durationMs: 0,
      sessionId: null, error: errMsg,
    };
    if (runId !== null) {
      updateActionRun(runId, {
        status: runResult.status,
        completedAt: Date.now(),
        error: errMsg,
      });
    }

    // Notifications for errors (non-transient-retry — those already returned above)
    if (cfg.notify?.length && runResult) {
      sendNotifications(cfg.notify, runResult, {
        actionName: name, runNumber, profile: cfg.agentProfile,
      }).catch(err2 => console.error(`[actions] Notification error for "${name}":`, err2));
    }
  } finally {
    exec.currentSessionId = null;
    state.lastRunAt = Date.now();

    logActivity({
      eventType: "action_complete",
      actionName: name,
      agentProfile: cfg.agentProfile,
      userProfile: effectiveUserProfile,
      summary: `Action "${name}" run #${runNumber}: ${runResult?.status ?? "unknown"}`,
      metadata: { status: runResult?.status, costUsd: runResult?.costUsd, durationMs: runResult?.durationMs, error: runResult?.error },
    });

    // Track cost on execution
    if (runResult && runResult.costUsd > 0) {
      exec.totalCostUsd += runResult.costUsd;
    }

    // Transient failures don't count against maxRuns
    if (!isTransient) {
      exec.cycleRunCount++;
    }

    // Check if execution is exhausted
    if (!isTransient && isExecutionExhausted(exec, cfg)) {
      closeExecution(exec, state);
      handleOnExhausted(state);
    }

    // Session/webhook/manual triggers: close execution after each run (no persistent lifecycle)
    if (!isTransient && cfg.trigger.type !== "interval" && cfg.trigger.type !== "action" && state.activeExecutions.has(exec.id)) {
      closeExecution(exec, state);
    }

    // Recalculate nextRunAt for interval triggers
    if (state.config.trigger.type === "interval") {
      const trigger = state.config.trigger;
      const intervalMs = parseInterval(trigger.every);
      const base = trigger.from === "start" ? runStartedAt : Date.now();
      state.nextRunAt = state.config.enabled ? base + intervalMs : null;
    }
  }

  // Post-run: fire chain watchers
  if (runResult) {
    for (const [watchName, watchState] of actionStates) {
      const watchTrigger = watchState.config.trigger;
      if (watchTrigger.type !== "action") continue;
      if (watchTrigger.source !== name) continue;
      if (!watchState.config.enabled) continue;

      const condition = watchTrigger.condition;
      if (condition === "any" || condition === runResult.status) {
        const chainTrigger: TriggerInfo = {
          type: "action",
          source: name,
          payload: runResult,
        };
        fireAction(watchName, chainTrigger, chainDepth + 1).catch(err => {
          console.error(`[actions] Chain trigger error for "${watchName}":`, err);
        });
      }
    }
  }
}

// ── Tick Loop (interval triggers only) ──

function tick(): void {
  const now = Date.now();
  for (const [name, state] of actionStates) {
    if (!state.config.enabled) continue;
    if (state.config.trigger.type !== "interval") continue;

    // Skip if a session is currently running (don't double-fire)
    const hasRunningSession = [...state.activeExecutions.values()].some(e => e.currentSessionId !== null);
    if (hasRunningSession) continue;

    const trigger = state.config.trigger;

    // Find or create an execution to check cycle state
    // For tick, we check if we need to advance cycles on the most recent execution
    // If no active execution, check if we should create one
    const exec = findActiveExecution(state);

    // If there's an active execution, check its run/cycle limits
    if (exec) {
      const { maxRuns, cycleInterval } = state.config;
      const atRunLimit = maxRuns && maxRuns > 0 && exec.cycleRunCount >= maxRuns;

      if (atRunLimit) {
        if (cycleInterval) {
          const cycleMs = parseInterval(cycleInterval);
          const nextCycleAt = (exec.cycleStartedAt ?? now) + cycleMs;
          if (now < nextCycleAt) {
            state.nextRunAt = nextCycleAt;
            continue;
          }
          const { maxCycles } = state.config;
          if (maxCycles && maxCycles > 0 && exec.cycleNumber >= maxCycles) {
            console.log(`[actions] "${name}" reached maxCycles (${maxCycles}) — auto-disabling`);
            closeExecution(exec, state);
            state.exhausted = true;
            setActionEnabled(name, false);
            continue;
          }
          exec.cycleNumber++;
          exec.cycleRunCount = 0;
          exec.cycleStartedAt = null;
          console.log(`[actions] "${name}" starting cycle #${exec.cycleNumber}`);
        } else {
          console.log(`[actions] "${name}" reached maxRuns (${maxRuns}) — auto-disabling`);
          closeExecution(exec, state);
          state.exhausted = true;
          setActionEnabled(name, false);
          continue;
        }
      }
    }

    if (!state.nextRunAt || now < state.nextRunAt) continue;
    if (!isWithinActiveHours(trigger.activeHours)) {
      state.nextRunAt = now + TICK_INTERVAL_MS;
      continue;
    }

    // Due — fire
    const triggerInfo: TriggerInfo = { type: "interval" };
    fireAction(name, triggerInfo).catch(err => {
      console.error(`[actions] Unhandled error in fireAction for "${name}":`, err);
    });
  }
}

// ── Public API ──

export function initActions(): void {
  loadActions();
  const count = Array.from(actionStates.values()).filter(s => s.config.enabled).length;
  console.log(`[actions] Loaded ${actionStates.size} action(s), ${count} enabled`);
  tickInterval = setInterval(tick, TICK_INTERVAL_MS);
}

export function stopActions(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  console.log("[actions] Stopped");
}

/** Get all actions with runtime state — derives flat fields from active executions for API compat */
export function getActions(): Array<ActionConfig & {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  cycleNumber: number;
  cycleRunCount: number;
  exhausted: boolean;
}> {
  return Array.from(actionStates.values()).map(s => {
    // Derive flat fields from most recent active execution
    const exec = findActiveExecution(s);
    return {
      ...s.config,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastStatus: exec?.lastStatus ?? null,
      running: s.activeExecutions.size > 0,
      cycleNumber: exec?.cycleNumber ?? 1,
      cycleRunCount: exec?.cycleRunCount ?? 0,
      exhausted: s.exhausted,
    };
  });
}

/** Get single action state */
export function getActionState(name: string): ActionState | undefined {
  return actionStates.get(name);
}

/** Manually trigger an action (bypasses interval and active hours) */
export async function triggerAction(name: string, opts?: { userProfile?: string }): Promise<boolean> {
  const state = actionStates.get(name);
  if (!state) return false;
  const maxConcurrency = state.config.concurrency ?? 1;
  if (state.activeExecutions.size >= maxConcurrency) return false;
  const triggerInfo: TriggerInfo = { type: "manual" };
  fireAction(name, triggerInfo, 0, opts).catch(err => {
    console.error(`[actions] Manual trigger error for "${name}":`, err);
  });
  return true;
}

/** Handle incoming webhook — validates token, fires the action */
export async function handleWebhook(name: string, token: string, payload?: unknown): Promise<{ ok: boolean; error?: string }> {
  const state = actionStates.get(name);
  if (!state) return { ok: false, error: "unknown action" };
  if (state.config.trigger.type !== "webhook") return { ok: false, error: "action is not webhook-triggered" };
  if (state.config.trigger.token !== token) return { ok: false, error: "invalid token" };
  if (!state.config.enabled) return { ok: false, error: "action is disabled" };

  const maxConcurrency = state.config.concurrency ?? 1;
  if (state.activeExecutions.size >= maxConcurrency) {
    console.log(`[actions] "${name}" at concurrency limit — dropping webhook trigger`);
    return { ok: false, error: "action at concurrency limit" };
  }

  const triggerInfo: TriggerInfo = { type: "webhook", payload };
  fireAction(name, triggerInfo).catch(err => {
    console.error(`[actions] Webhook trigger error for "${name}":`, err);
  });
  return { ok: true };
}

/** Toggle an action on/off — persists to action.json */
export function setActionEnabled(name: string, enabled: boolean): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  state.config.enabled = enabled;
  if (enabled) state.exhausted = false;
  const configPath = join(state.actionDir, "action.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  if (enabled && state.config.trigger.type === "interval") {
    state.nextRunAt = Date.now() + parseInterval(state.config.trigger.every);
  } else if (!enabled) {
    state.nextRunAt = null;
  }
  return true;
}

/** Update action config fields — persists to action.json */
export function updateActionConfig(
  name: string,
  updates: { enabled?: boolean; interval?: string },
): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  if (updates.enabled !== undefined) {
    state.config.enabled = updates.enabled;
  }
  if (updates.interval !== undefined && state.config.trigger.type === "interval") {
    parseInterval(updates.interval);
    state.config.trigger.every = updates.interval;
  }
  const configPath = join(state.actionDir, "action.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  const running = state.activeExecutions.size > 0;
  if (state.config.enabled && !running && state.config.trigger.type === "interval") {
    state.nextRunAt = Date.now() + parseInterval(state.config.trigger.every);
  } else if (!state.config.enabled) {
    state.nextRunAt = null;
  }
  return true;
}

/** Reset an action — marks old executions as "reset", preserves history */
export function resetAction(name: string): boolean {
  const state = actionStates.get(name);
  if (!state) return false;

  // Close all active executions as "reset" (data preserved in DB)
  for (const [id, exec] of state.activeExecutions) {
    exec.status = "reset";
    dbUpdateExecution(id, { status: "reset", completedAt: Date.now() });
  }
  state.activeExecutions.clear();
  state.exhausted = false;

  // Restart interval if enabled
  if (state.config.enabled && state.config.trigger.type === "interval") {
    state.nextRunAt = Date.now() + parseInterval(state.config.trigger.every);
  }

  console.log(`[actions] Reset action "${name}" — old executions archived, ready for new execution`);
  return true;
}

/** Save a preference for an action */
export function setActionPreference(name: string, key: string, value: boolean): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  const configPath = join(state.actionDir, "action.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!config.preferences) config.preferences = {};
  config.preferences[key] = value;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  state.config = config;
  return true;
}

/** Get action preferences */
export function getActionPreferences(name: string): Record<string, boolean> {
  const state = actionStates.get(name);
  return (state?.config as any)?.preferences ?? {};
}

/** Add a tag to an action */
export function addActionTag(name: string, tag: string): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  if (!state.config.tags) state.config.tags = [];
  if (state.config.tags.includes(tag)) return true;
  state.config.tags.push(tag);
  const configPath = join(state.actionDir, "action.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  return true;
}

/** Remove a tag from an action */
export function removeActionTag(name: string, tag: string): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  if (!state.config.tags) return true;
  state.config.tags = state.config.tags.filter(t => t !== tag);
  if (state.config.tags.length === 0) delete state.config.tags;
  const configPath = join(state.actionDir, "action.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  return true;
}

/** Cancel an active execution */
export function cancelExecution(actionName: string, executionId: number): boolean {
  const state = actionStates.get(actionName);
  if (!state) return false;
  const exec = state.activeExecutions.get(executionId);
  if (!exec) return false;
  exec.status = "cancelled";
  dbUpdateExecution(executionId, { status: "cancelled", completedAt: Date.now() });
  state.activeExecutions.delete(executionId);
  console.log(`[actions] Cancelled execution #${executionId} for "${actionName}"`);
  return true;
}

/** Manually start a new execution for an action */
export function startNewExecution(actionName: string): { ok: boolean; executionId?: number; error?: string } {
  const state = actionStates.get(actionName);
  if (!state) return { ok: false, error: "action not found" };
  const maxConcurrency = state.config.concurrency ?? 1;
  if (state.activeExecutions.size >= maxConcurrency) {
    return { ok: false, error: `at concurrency limit (${maxConcurrency})` };
  }
  const exec = createExecution(actionName, state.config);
  state.activeExecutions.set(exec.id, exec);
  console.log(`[actions] Manually created execution #${exec.id} for "${actionName}"`);
  return { ok: true, executionId: exec.id };
}

// ── Session Trigger Matching ──

function matchesRound(spec: number | `every:${number}` | `after:${number}`, actual: number): boolean {
  if (typeof spec === "number") return actual === spec;
  if (typeof spec === "string") {
    if (spec.startsWith("every:")) {
      const n = parseInt(spec.slice(6));
      return n > 0 && actual > 0 && actual % n === 0;
    }
    if (spec.startsWith("after:")) {
      const n = parseInt(spec.slice(6));
      return actual >= n;
    }
  }
  return false;
}

/** Called by session-manager when a session lifecycle event occurs.
 *  Scans all loaded actions for matching session triggers and fires them. */
export function onSessionEvent(
  event: SessionTriggerEvent,
  session: {
    id: string;
    userProfile?: string;
    tags: string[];
    preview: string;
    title?: string | null;
    messageCount: number;
    lastResponse?: string;
  },
): void {
  for (const [name, state] of actionStates) {
    if (!state.config.enabled) continue;
    const trigger = state.config.trigger;
    if (trigger.type !== "session") continue;

    // Check excludeTags (default: ["internal"])
    const excludeTags = trigger.excludeTags ?? ["internal"];
    if (excludeTags.some(t => session.tags.includes(t))) continue;

    // Check userProfile scoping
    if (state.config.userProfile && session.userProfile !== state.config.userProfile) continue;

    // Match the event against the trigger's `on` spec
    const on = trigger.on;
    let matched = false;
    let round = 0;
    let role: "user" | "assistant" = "user";

    if (typeof event === "string" && typeof on === "string") {
      // Flat events: "archived", "deleted"
      matched = event === on;
    } else if (typeof event === "object" && typeof on === "object" && typeof event.round === "number") {
      // Round-based events
      if (event.role === on.role && event.at === on.at && matchesRound(on.round, event.round)) {
        matched = true;
        round = event.round;
        role = event.role;
      }
    }

    if (!matched) continue;

    const payload: SessionTriggerPayload = {
      sessionId: session.id,
      userProfile: session.userProfile,
      preview: session.preview,
      title: session.title,
      tags: session.tags,
      messageCount: session.messageCount,
      round,
      role,
      lastResponse: session.lastResponse,
    };

    const triggerInfo: TriggerInfo = { type: "session", payload };
    console.log(`[actions] Session trigger matched: "${name}" on ${typeof event === "string" ? event : `${event.role}:${event.at}:${event.round}`} for session ${session.id.slice(0, 12)}…`);

    fireAction(name, triggerInfo).catch(err => {
      console.error(`[actions] Session trigger error for "${name}":`, err);
    });
  }
}

/** Reload actions from disk without restart */
export function reloadActions(): void {
  loadActions();
  console.log(`[actions] Reloaded — ${actionStates.size} action(s)`);
}
