/**
 * Action Runner — orchestrates automated agent sessions.
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
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { startSession, getActiveSession } from "./session-manager";
import {
  insertActionRun, updateActionRun, getActionRuns as dbGetActionRuns,
  getRunSummaries as dbGetRunSummaries, getNextRunNumber, getSession,
  listSessions, getEvents, searchSessions, clearActionRuns,
} from "./db";
import type { SessionRow, EventRow, SearchHit } from "./db";
import type {
  ActionConfig, ActionContext, ActionModule, RunResult,
  ActionState, ActionDB, TriggerInfo,
  SessionInfo, SearchResult, EventInfo,
} from "./action-types";
import { MAX_CHAIN_DEPTH } from "./action-types";

// ── Constants ──

const ACTIONS_DIR = join(import.meta.dir, "actions");
const TICK_INTERVAL_MS = 10_000;       // check every 10 seconds
const SESSION_TIMEOUT_MS = 30 * 60_000; // 30 minute max per run
const POLL_INTERVAL_MS = 2_000;        // poll session status every 2s

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

// ── Action Loading ──

function loadActions(): void {
  if (!existsSync(ACTIONS_DIR)) return;
  const dirs = readdirSync(ACTIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    const configPath = join(ACTIONS_DIR, name, "action.json");
    if (!existsSync(configPath)) continue;
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as ActionConfig;
      config.name = name; // ensure name matches directory

      // Validate interval triggers
      if (config.trigger.type === "interval") {
        parseInterval(config.trigger.every);
      }

      // Auto-generate webhook token if absent
      if (config.trigger.type === "webhook" && !config.trigger.token) {
        config.trigger.token = crypto.randomUUID();
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        console.log(`[actions] Generated webhook token for "${name}"`);
      }

      const existing = actionStates.get(name);
      const lastRunNumber = getNextRunNumber(name) - 1;

      // Load last run info from DB
      const lastRuns = dbGetActionRuns(name, 1);
      const lastRun = lastRuns[0];

      // Determine cycle state from DB
      let currentCycle = lastRun?.cycleNumber ?? 1;
      const recentRuns = dbGetActionRuns(name, 100);
      let cycleRunCount = recentRuns.filter(r => r.cycleNumber === currentCycle).length;

      // If cycle is already full and we have cycleInterval, advance to next cycle
      if (config.cycleInterval && config.maxRuns && cycleRunCount >= config.maxRuns) {
        currentCycle++;
        cycleRunCount = 0;
      }

      // Compute nextRunAt for interval triggers
      let nextRunAt: number | null = null;
      if (config.enabled && config.trigger.type === "interval") {
        nextRunAt = Date.now() + parseInterval(config.trigger.every);
      }

      actionStates.set(name, {
        config,
        running: existing?.running ?? false,
        currentSessionId: existing?.currentSessionId ?? null,
        lastRunAt: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
        nextRunAt,
        lastStatus: lastRun?.status ?? null,
        runNumber: lastRunNumber,
        cycleNumber: existing?.cycleNumber ?? currentCycle,
        cycleRunCount: existing?.cycleRunCount ?? cycleRunCount,
        cycleStartedAt: existing?.cycleStartedAt ?? null,
      });
    } catch (err) {
      console.error(`[actions] Failed to load action "${name}":`, err);
    }
  }
}

// ── Session Monitoring ──

async function monitorSession(
  sessionId: string,
  actionName: string,
  runId: number,
  state: ActionState,
): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < SESSION_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    // Check in-memory active session first
    const active = getActiveSession(sessionId);
    if (active) {
      if (active.status === "idle" || active.status === "done" || active.status === "error") {
        const dbSession = getSession(sessionId);
        const summary = dbSession?.last_response?.slice(0, 500) ?? "";

        updateActionRun(runId, {
          status: active.status === "error" ? "error" : "done",
          summary,
          completedAt: Date.now(),
          costUsd: active.costUsd,
          error: active.status === "error" ? (active.error ?? "unknown error") : undefined,
        });

        state.lastStatus = active.status === "error" ? "error" : "done";
        console.log(`[actions] Run #${state.runNumber} completed for "${actionName}": ${active.status}`);
        return;
      }
      continue; // still running
    }

    // Fallback: check DB (session may have exited active map)
    const dbSession = getSession(sessionId);
    if (dbSession && (dbSession.status === "done" || dbSession.status === "idle" || dbSession.status === "error")) {
      updateActionRun(runId, {
        status: dbSession.status === "error" ? "error" : "done",
        summary: dbSession.last_response?.slice(0, 500) ?? "",
        completedAt: Date.now(),
        costUsd: dbSession.total_cost_usd,
        error: dbSession.status === "error" ? "session error" : undefined,
      });
      state.lastStatus = dbSession.status === "error" ? "error" : "done";
      console.log(`[actions] Run #${state.runNumber} completed for "${actionName}" (from DB): ${dbSession.status}`);
      return;
    }
  }

  // Timeout
  console.error(`[actions] Run #${state.runNumber} timed out for "${actionName}" after ${SESSION_TIMEOUT_MS / 60000}m`);
  updateActionRun(runId, {
    status: "error",
    completedAt: Date.now(),
    error: `timeout after ${SESSION_TIMEOUT_MS / 60000} minutes`,
  });
  state.lastStatus = "error";
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
  };
}

// ── Core: Fire an Action ──

async function fireAction(
  name: string,
  triggerInfo: TriggerInfo,
  chainDepth: number = 0,
  overrides?: { userProfile?: string },
): Promise<void> {
  // Chain depth guard
  if (chainDepth >= MAX_CHAIN_DEPTH) {
    console.error(`[actions] Chain depth limit (${MAX_CHAIN_DEPTH}) reached — refusing to fire "${name}"`);
    return;
  }

  const state = actionStates.get(name);
  if (!state) {
    console.error(`[actions] Unknown action "${name}" — skipping`);
    return;
  }

  // Concurrency: drop + log
  if (state.running) {
    console.log(`[actions] "${name}" already running — dropping ${triggerInfo.type} trigger`);
    return;
  }

  state.running = true;
  const runStartedAt = Date.now();
  const runNumber = getNextRunNumber(name);
  state.runNumber = runNumber;

  // Start cycle clock on first run of a cycle
  if (!state.cycleStartedAt) {
    state.cycleStartedAt = Date.now();
  }

  console.log(`[actions] Starting run #${runNumber} (cycle #${state.cycleNumber}, run ${state.cycleRunCount + 1}/${state.config.maxRuns ?? "∞"}) for "${name}" [${triggerInfo.type}]`);

  let runId: number | null = null;
  let runResult: RunResult | null = null;

  try {
    // Dynamic import context.ts — cache bust so edits are picked up
    const contextPath = join(ACTIONS_DIR, name, "context.ts");
    if (!existsSync(contextPath)) {
      throw new Error(`Missing context.ts for action "${name}"`);
    }
    const mod: ActionModule = await import(`${contextPath}?t=${Date.now()}`);
    if (typeof mod.gather !== "function") {
      throw new Error(`context.ts for "${name}" does not export a gather() function`);
    }

    // Build context
    const db = buildActionDB(name);
    const ctx: ActionContext = {
      actionName: name,
      runNumber,
      cycleNumber: state.cycleNumber,
      cycleRunIndex: state.cycleRunCount,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt) : null,
      db,
      trigger: triggerInfo,
    };

    // Gather prompt
    const prompt = await mod.gather(ctx);
    if (!prompt || typeof prompt !== "string") {
      throw new Error(`gather() returned invalid prompt for "${name}": ${typeof prompt}`);
    }

    // Insert action_runs row
    const startedAt = Date.now();
    const effectiveUserProfile = overrides?.userProfile ?? state.config.userProfile;
    runId = insertActionRun(name, runNumber, null, startedAt, state.cycleNumber, triggerInfo.type, effectiveUserProfile);

    // Spawn fresh session
    const cfg = state.config;
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

    // Wait for real session ID (pending-* → real ID)
    const idStart = Date.now();
    while (session.sessionId.startsWith("pending-") && Date.now() - idStart < 15_000) {
      await new Promise(r => setTimeout(r, 200));
    }

    state.currentSessionId = session.sessionId;
    console.log(`[actions] Run #${runNumber} for "${name}" → session ${session.sessionId}`);

    // Update run row with session ID
    updateActionRun(runId, { sessionId: session.sessionId, status: "running" });

    // Monitor until session completes
    const runStart = Date.now();
    await monitorSession(session.sessionId, name, runId, state);

    // Build RunResult
    const dbSession = getSession(session.sessionId);
    runResult = {
      status: state.lastStatus === "error" ? "error" : "done",
      response: dbSession?.last_response ?? null,
      summary: dbSession?.last_response?.slice(0, 500) ?? null,
      costUsd: dbSession?.total_cost_usd ?? 0,
      durationMs: Date.now() - runStart,
      sessionId: session.sessionId,
      error: state.lastStatus === "error" ? (dbSession?.last_response ?? "unknown") : null,
    };

    // afterRun hook — failures are isolated from run status
    if (typeof mod.afterRun === "function") {
      try {
        await mod.afterRun(ctx, runResult);
        console.log(`[actions] afterRun completed for "${name}" run #${runNumber}`);
      } catch (hookErr: any) {
        const afterRunError = String(hookErr?.message ?? hookErr);
        console.error(`[actions] afterRun failed for "${name}" run #${runNumber}:`, hookErr);
        updateActionRun(runId, { afterRunError });
      }
    }

  } catch (err: any) {
    console.error(`[actions] Run #${runNumber} failed for "${name}":`, err);
    state.lastStatus = "error";
    if (runId !== null) {
      updateActionRun(runId, {
        status: "error",
        completedAt: Date.now(),
        error: String(err?.message ?? err),
      });
    }
  } finally {
    state.running = false;
    state.currentSessionId = null;
    state.lastRunAt = Date.now();
    state.cycleRunCount++;

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
    if (state.running) continue;
    if (state.config.trigger.type !== "interval") continue;

    const trigger = state.config.trigger;
    const { maxRuns, cycleInterval } = state.config;
    const atRunLimit = maxRuns && maxRuns > 0 && state.cycleRunCount >= maxRuns;

    if (atRunLimit) {
      if (cycleInterval) {
        // Cycle mode: wait for cycleInterval then start new cycle
        const cycleMs = parseInterval(cycleInterval);
        const nextCycleAt = (state.cycleStartedAt ?? now) + cycleMs;
        if (now < nextCycleAt) {
          state.nextRunAt = nextCycleAt;
          continue;
        }
        // Check maxCycles before starting a new one
        const { maxCycles } = state.config;
        if (maxCycles && maxCycles > 0 && state.cycleNumber >= maxCycles) {
          console.log(`[actions] "${name}" reached maxCycles (${maxCycles}) — auto-disabling`);
          setActionEnabled(name, false);
          continue;
        }
        // New cycle
        state.cycleNumber++;
        state.cycleRunCount = 0;
        state.cycleStartedAt = null;
        console.log(`[actions] "${name}" starting cycle #${state.cycleNumber}`);
      } else {
        // No cycleInterval = lifetime cap, auto-disable
        console.log(`[actions] "${name}" reached maxRuns (${maxRuns}) — auto-disabling`);
        setActionEnabled(name, false);
        continue;
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

/** Get all actions with runtime state */
export function getActions(): Array<ActionConfig & {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  cycleNumber: number;
  cycleRunCount: number;
}> {
  return Array.from(actionStates.values()).map(s => ({
    ...s.config,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    running: s.running,
    cycleNumber: s.cycleNumber,
    cycleRunCount: s.cycleRunCount,
  }));
}

/** Get single action state */
export function getActionState(name: string): ActionState | undefined {
  return actionStates.get(name);
}

/** Manually trigger an action (bypasses interval and active hours) */
export async function triggerAction(name: string, opts?: { userProfile?: string }): Promise<boolean> {
  const state = actionStates.get(name);
  if (!state || state.running) return false;
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

  if (state.running) {
    console.log(`[actions] "${name}" already running — dropping webhook trigger`);
    return { ok: false, error: "action already running" };
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
  const configPath = join(ACTIONS_DIR, name, "action.json");
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
    parseInterval(updates.interval); // validate
    state.config.trigger.every = updates.interval;
  }
  // Persist
  const configPath = join(ACTIONS_DIR, name, "action.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  // Recalculate next run
  if (state.config.enabled && !state.running && state.config.trigger.type === "interval") {
    state.nextRunAt = Date.now() + parseInterval(state.config.trigger.every);
  } else if (!state.config.enabled) {
    state.nextRunAt = null;
  }
  return true;
}

/** Reset an action — clears runs, resets cycle/run counters */
export function resetAction(name: string): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  if (state.running) return false;

  clearActionRuns(name);

  state.cycleNumber = 1;
  state.cycleRunCount = 0;
  state.runNumber = 0;
  state.lastRunAt = null;
  state.lastStatus = null;
  state.cycleStartedAt = null;

  if (state.config.enabled && state.config.trigger.type === "interval") {
    state.nextRunAt = Date.now() + parseInterval(state.config.trigger.every);
  }

  console.log(`[actions] Reset action "${name}" — counters zeroed, history cleared`);
  return true;
}

/** Save a preference for an action */
export function setActionPreference(name: string, key: string, value: boolean): boolean {
  const state = actionStates.get(name);
  if (!state) return false;
  const configPath = join(ACTIONS_DIR, name, "action.json");
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

/** Reload actions from disk without restart */
export function reloadActions(): void {
  loadActions();
  console.log(`[actions] Reloaded — ${actionStates.size} action(s)`);
}
