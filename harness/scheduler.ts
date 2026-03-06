/**
 * Scheduler Engine — orchestrates timed agent sessions.
 *
 * Schedules are directories in harness/schedules/<name>/ containing:
 *   - schedule.json  → ScheduleConfig (timing, agent profile ref)
 *   - context.ts     → ScheduleModule (gather function that builds the prompt)
 *
 * The scheduler is a meta layer: it uses the existing session-manager to spawn
 * fresh sessions on a cadence. Each run is independent. Continuity comes from
 * the context.ts gather() function using built-in DB utilities (getRunSummaries).
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { startSession, getActiveSession } from "./session-manager";
import {
  insertScheduleRun, updateScheduleRun, getScheduleRuns as dbGetScheduleRuns,
  getRunSummaries as dbGetRunSummaries, getNextRunNumber, getSession,
  listSessions, getEvents, searchSessions, clearScheduleRuns,
} from "./db";
import type { SessionRow, EventRow, SearchHit } from "./db";
import type {
  ScheduleConfig, ScheduleContext, ScheduleModule, RunResult,
  ScheduleState, ScheduleDB,
  SessionInfo, SearchResult, EventInfo,
} from "./scheduler-types";

// ── Constants ──

const SCHEDULES_DIR = join(import.meta.dir, "schedules");
const TICK_INTERVAL_MS = 10_000;       // check every 10 seconds
const SESSION_TIMEOUT_MS = 30 * 60_000; // 30 minute max per run
const POLL_INTERVAL_MS = 2_000;        // poll session status every 2s

// ── State ──

const scheduleStates = new Map<string, ScheduleState>();
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
  throw new Error(`Invalid interval: "${interval}" — use "30m", "1h", "4h", etc.`);
}

// ── Active Hours ──

function isWithinActiveHours(config: ScheduleConfig): boolean {
  if (!config.activeHours) return true;
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH = 0, startM = 0] = config.activeHours.start.split(":").map(Number);
  const [endH = 0, endM = 0] = config.activeHours.end.split(":").map(Number);
  const start = startH * 60 + startM;
  const end = endH * 60 + endM;
  if (start <= end) return currentMinutes >= start && currentMinutes < end;
  // Wraps midnight (e.g., 22:00 - 06:00)
  return currentMinutes >= start || currentMinutes < end;
}

// ── Schedule Loading ──

function loadSchedules(): void {
  if (!existsSync(SCHEDULES_DIR)) return;
  const dirs = readdirSync(SCHEDULES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const name of dirs) {
    const configPath = join(SCHEDULES_DIR, name, "schedule.json");
    if (!existsSync(configPath)) continue;
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8")) as ScheduleConfig;
      config.name = name; // ensure name matches directory

      // Validate interval
      parseInterval(config.interval);

      const existing = scheduleStates.get(name);
      const lastRunNumber = getNextRunNumber(name) - 1;

      // Load last run info from DB
      const lastRuns = dbGetScheduleRuns(name, 1);
      const lastRun = lastRuns[0];

      // Determine cycle state from DB
      let currentCycle = lastRun?.cycleNumber ?? 1;
      const recentRuns = dbGetScheduleRuns(name, 100);
      let cycleRunCount = recentRuns.filter(r => r.cycleNumber === currentCycle).length;

      // If cycle is already full and we have cycleInterval, advance to next cycle
      if (config.cycleInterval && config.maxRuns && cycleRunCount >= config.maxRuns) {
        currentCycle++;
        cycleRunCount = 0;
      }

      scheduleStates.set(name, {
        config,
        running: existing?.running ?? false,
        currentSessionId: existing?.currentSessionId ?? null,
        lastRunAt: lastRun?.completedAt ?? lastRun?.startedAt ?? null,
        nextRunAt: config.enabled
          ? Date.now() + parseInterval(config.interval)
          : null,
        lastStatus: lastRun?.status ?? null,
        runNumber: lastRunNumber,
        cycleNumber: existing?.cycleNumber ?? currentCycle,
        cycleRunCount: existing?.cycleRunCount ?? cycleRunCount,
        cycleStartedAt: existing?.cycleStartedAt ?? null,
      });
    } catch (err) {
      console.error(`[scheduler] Failed to load schedule "${name}":`, err);
    }
  }
}

// ── Session Monitoring ──

async function monitorSession(
  sessionId: string,
  scheduleName: string,
  runId: number,
  state: ScheduleState,
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

        updateScheduleRun(runId, {
          status: active.status === "error" ? "error" : "done",
          summary,
          completedAt: Date.now(),
          costUsd: active.costUsd,
          error: active.status === "error" ? (active.error ?? "unknown error") : undefined,
        });

        state.lastStatus = active.status === "error" ? "error" : "done";
        console.log(`[scheduler] Run #${state.runNumber} completed for "${scheduleName}": ${active.status}`);
        return;
      }
      continue; // still running
    }

    // Fallback: check DB (session may have exited active map)
    const dbSession = getSession(sessionId);
    if (dbSession && (dbSession.status === "done" || dbSession.status === "idle" || dbSession.status === "error")) {
      updateScheduleRun(runId, {
        status: dbSession.status === "error" ? "error" : "done",
        summary: dbSession.last_response?.slice(0, 500) ?? "",
        completedAt: Date.now(),
        costUsd: dbSession.total_cost_usd,
        error: dbSession.status === "error" ? "session error" : undefined,
      });
      state.lastStatus = dbSession.status === "error" ? "error" : "done";
      console.log(`[scheduler] Run #${state.runNumber} completed for "${scheduleName}" (from DB): ${dbSession.status}`);
      return;
    }
  }

  // Timeout
  console.error(`[scheduler] Run #${state.runNumber} timed out for "${scheduleName}" after ${SESSION_TIMEOUT_MS / 60000}m`);
  updateScheduleRun(runId, {
    status: "error",
    completedAt: Date.now(),
    error: `timeout after ${SESSION_TIMEOUT_MS / 60000} minutes`,
  });
  state.lastStatus = "error";
}

// ── DB Row Mappers (DB rows → clean schedule-facing types) ──

function mapSession(r: SessionRow): SessionInfo {
  return {
    id: r.id, preview: r.preview, profile: r.profile, model: r.model,
    status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at, messageCount: r.message_count,
    totalCostUsd: r.total_cost_usd, lastPrompt: r.last_prompt,
    lastResponse: r.last_response, cwd: r.cwd, scheduleName: r.schedule_name,
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

function buildScheduleDB(scheduleName: string): ScheduleDB {
  return {
    getRunSummaries: (limit = 20) => dbGetRunSummaries(scheduleName, limit),
    getRunHistory: (limit = 20) => dbGetScheduleRuns(scheduleName, limit),
    getScheduleRuns: (name, limit = 20) => dbGetScheduleRuns(name, limit),
    listSessions: (limit = 50) => listSessions(limit).map(mapSession),
    getSession: (id) => { const s = getSession(id); return s ? mapSession(s) : null; },
    searchSessions: (query, limit = 20) => searchSessions(query, limit).map(mapSearchHit),
    getEvents: (sessionId, afterSeq = 0) => getEvents(sessionId, afterSeq).map(mapEvent),
  };
}

// ── Run Execution ──

async function executeRun(name: string, overrides?: { userProfile?: string }): Promise<void> {
  const state = scheduleStates.get(name);
  if (!state || state.running) return;

  state.running = true;
  const runStartedAt = Date.now();
  const runNumber = getNextRunNumber(name);
  state.runNumber = runNumber;
  // Start cycle clock on first run of a cycle
  if (!state.cycleStartedAt) {
    state.cycleStartedAt = Date.now();
  }
  console.log(`[scheduler] Starting run #${runNumber} (cycle #${state.cycleNumber}, run ${state.cycleRunCount + 1}/${state.config.maxRuns ?? "∞"}) for "${name}"`);

  let runId: number | null = null;

  try {
    // Dynamic import context.ts — cache bust so edits are picked up without restart
    const contextPath = join(SCHEDULES_DIR, name, "context.ts");
    if (!existsSync(contextPath)) {
      throw new Error(`Missing context.ts for schedule "${name}"`);
    }
    const mod: ScheduleModule = await import(`${contextPath}?t=${Date.now()}`);
    if (typeof mod.gather !== "function") {
      throw new Error(`context.ts for "${name}" does not export a gather() function`);
    }

    // Build context with unified DB access
    const db = buildScheduleDB(name);
    const ctx: ScheduleContext = {
      scheduleName: name,
      runNumber,
      cycleNumber: state.cycleNumber,
      cycleRunIndex: state.cycleRunCount,
      lastRunAt: state.lastRunAt ? new Date(state.lastRunAt) : null,
      db,
    };

    // Gather prompt
    const prompt = await mod.gather(ctx);
    if (!prompt || typeof prompt !== "string") {
      throw new Error(`gather() returned invalid prompt for "${name}": ${typeof prompt}`);
    }

    // Insert schedule_runs row
    const startedAt = Date.now();
    const effectiveUserProfile = overrides?.userProfile ?? state.config.userProfile;
    runId = insertScheduleRun(name, runNumber, null, startedAt, state.cycleNumber, effectiveUserProfile);

    // Spawn fresh session via existing session manager
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
      scheduleName: name,
      userProfile: effectiveUserProfile,
    });

    // Wait for real session ID (pending-* → real ID)
    const idStart = Date.now();
    while (session.sessionId.startsWith("pending-") && Date.now() - idStart < 15_000) {
      await new Promise(r => setTimeout(r, 200));
    }

    state.currentSessionId = session.sessionId;
    console.log(`[scheduler] Run #${runNumber} for "${name}" → session ${session.sessionId}`);

    // Update run row with session ID
    updateScheduleRun(runId, { sessionId: session.sessionId, status: "running" });

    // Monitor until session completes
    const runStart = Date.now();
    await monitorSession(session.sessionId, name, runId, state);

    // Call afterRun hook if the module exports one
    if (typeof mod.afterRun === "function") {
      try {
        const dbSession = getSession(session.sessionId);
        const runResult: RunResult = {
          status: state.lastStatus === "error" ? "error" : "done",
          response: dbSession?.last_response ?? null,
          summary: dbSession?.last_response?.slice(0, 500) ?? null,
          costUsd: dbSession?.total_cost_usd ?? 0,
          durationMs: Date.now() - runStart,
          sessionId: session.sessionId,
          error: state.lastStatus === "error" ? (dbSession?.last_response ?? "unknown") : null,
        };
        await mod.afterRun(ctx, runResult);
        console.log(`[scheduler] afterRun hook completed for "${name}" run #${runNumber}`);
      } catch (hookErr: any) {
        console.error(`[scheduler] afterRun hook failed for "${name}" run #${runNumber}:`, hookErr);
      }
    }

  } catch (err: any) {
    console.error(`[scheduler] Run #${runNumber} failed for "${name}":`, err);
    state.lastStatus = "error";
    if (runId !== null) {
      updateScheduleRun(runId, {
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
    const intervalMs = parseInterval(state.config.interval);
    const base = state.config.intervalFrom === "start" ? runStartedAt : Date.now();
    state.nextRunAt = state.config.enabled ? base + intervalMs : null;
  }
}

// ── Tick Loop ──

function tick(): void {
  const now = Date.now();
  for (const [name, state] of scheduleStates) {
    if (!state.config.enabled) continue;
    if (state.running) continue;

    const { maxRuns, cycleInterval } = state.config;
    const atRunLimit = maxRuns && maxRuns > 0 && state.cycleRunCount >= maxRuns;

    if (atRunLimit) {
      if (cycleInterval) {
        // Cycle mode: wait for cycleInterval then start new cycle
        const cycleMs = parseInterval(cycleInterval);
        const nextCycleAt = (state.cycleStartedAt ?? now) + cycleMs;
        if (now < nextCycleAt) {
          state.nextRunAt = nextCycleAt;
          continue; // still waiting for next cycle
        }
        // Check maxCycles before starting a new one
        const { maxCycles } = state.config;
        if (maxCycles && maxCycles > 0 && state.cycleNumber >= maxCycles) {
          console.log(`[scheduler] "${name}" reached maxCycles (${maxCycles}) — auto-disabling`);
          setScheduleEnabled(name, false);
          continue;
        }
        // New cycle
        state.cycleNumber++;
        state.cycleRunCount = 0;
        state.cycleStartedAt = null;
        console.log(`[scheduler] "${name}" starting cycle #${state.cycleNumber}`);
        // fall through to normal run logic
      } else {
        // No cycleInterval = lifetime cap, auto-disable
        console.log(`[scheduler] "${name}" reached maxRuns (${maxRuns}) — auto-disabling`);
        setScheduleEnabled(name, false);
        continue;
      }
    }

    if (!state.nextRunAt || now < state.nextRunAt) continue;
    if (!isWithinActiveHours(state.config)) {
      state.nextRunAt = now + TICK_INTERVAL_MS;
      continue;
    }
    // Due — fire
    executeRun(name).catch(err => {
      console.error(`[scheduler] Unhandled error in executeRun for "${name}":`, err);
    });
  }
}

// ── Public API ──

export function initScheduler(): void {
  loadSchedules();
  const count = Array.from(scheduleStates.values()).filter(s => s.config.enabled).length;
  console.log(`[scheduler] Loaded ${scheduleStates.size} schedule(s), ${count} enabled`);
  tickInterval = setInterval(tick, TICK_INTERVAL_MS);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  console.log("[scheduler] Stopped");
}

/** Get all schedules with runtime state */
export function getSchedules(): Array<ScheduleConfig & {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  running: boolean;
  cycleNumber: number;
  cycleRunCount: number;
}> {
  return Array.from(scheduleStates.values()).map(s => ({
    ...s.config,
    nextRunAt: s.nextRunAt,
    lastRunAt: s.lastRunAt,
    lastStatus: s.lastStatus,
    running: s.running,
    cycleNumber: s.cycleNumber,
    cycleRunCount: s.cycleRunCount,
  }));
}

/** Get single schedule state */
export function getScheduleState(name: string): ScheduleState | undefined {
  return scheduleStates.get(name);
}

/** Manually trigger a run (bypasses interval and active hours) */
export async function triggerSchedule(name: string, opts?: { userProfile?: string }): Promise<boolean> {
  const state = scheduleStates.get(name);
  if (!state || state.running) return false;
  executeRun(name, opts).catch(err => {
    console.error(`[scheduler] Manual trigger error for "${name}":`, err);
  });
  return true;
}

/** Toggle a schedule on/off — persists to schedule.json */
export function setScheduleEnabled(name: string, enabled: boolean): boolean {
  const state = scheduleStates.get(name);
  if (!state) return false;
  state.config.enabled = enabled;
  const configPath = join(SCHEDULES_DIR, name, "schedule.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  if (enabled) {
    state.nextRunAt = Date.now() + parseInterval(state.config.interval);
  } else {
    state.nextRunAt = null;
  }
  return true;
}

/** Update schedule config fields — persists to schedule.json */
export function updateScheduleConfig(
  name: string,
  updates: { enabled?: boolean; interval?: string },
): boolean {
  const state = scheduleStates.get(name);
  if (!state) return false;
  if (updates.enabled !== undefined) {
    state.config.enabled = updates.enabled;
  }
  if (updates.interval !== undefined) {
    parseInterval(updates.interval); // validate before saving
    state.config.interval = updates.interval;
  }
  // Persist
  const configPath = join(SCHEDULES_DIR, name, "schedule.json");
  writeFileSync(configPath, JSON.stringify(state.config, null, 2) + "\n", "utf-8");
  // Recalculate next run
  if (state.config.enabled && !state.running) {
    state.nextRunAt = Date.now() + parseInterval(state.config.interval);
  } else if (!state.config.enabled) {
    state.nextRunAt = null;
  }
  return true;
}

/** Reset a schedule — clears runs, resets cycle/run counters to 0 */
export function resetSchedule(name: string): boolean {
  const state = scheduleStates.get(name);
  if (!state) return false;
  if (state.running) return false; // can't reset while running

  // Clear run history from DB
  clearScheduleRuns(name);

  // Reset in-memory state
  state.cycleNumber = 1;
  state.cycleRunCount = 0;
  state.runNumber = 0;
  state.lastRunAt = null;
  state.lastStatus = null;
  state.cycleStartedAt = null;

  // Recalculate next run
  if (state.config.enabled) {
    state.nextRunAt = Date.now() + parseInterval(state.config.interval);
  }

  console.log(`[scheduler] Reset schedule "${name}" — counters zeroed, history cleared`);
  return true;
}

/** Save skipConfirm preference for a schedule action */
export function setSchedulePreference(name: string, key: string, value: boolean): boolean {
  const state = scheduleStates.get(name);
  if (!state) return false;
  const configPath = join(SCHEDULES_DIR, name, "schedule.json");
  // Read, patch, write
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  if (!config.preferences) config.preferences = {};
  config.preferences[key] = value;
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  state.config = config;
  return true;
}

/** Get schedule preferences */
export function getSchedulePreferences(name: string): Record<string, boolean> {
  const state = scheduleStates.get(name);
  return (state?.config as any)?.preferences ?? {};
}

/** Reload schedules from disk without restart */
export function reloadSchedules(): void {
  loadSchedules();
  console.log(`[scheduler] Reloaded — ${scheduleStates.size} schedule(s)`);
}
