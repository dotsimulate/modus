/**
 * Wake Scheduler — scheduled + event-driven session wakes.
 *
 * `ctx.sessions.wake(target, content, when)` with an immediate `when` ("now") is
 * delivered straight away by harness-context via session-manager.deliverToSession.
 * Anything scheduled — `{at}`, `{every}`, `{onEvent}` — lands here.
 *
 * This is a small, self-contained capability engine (NOT folded into action-runner):
 *   - one tick loop fires due `at` (one-shot) and `every` (recurring) wakes
 *   - `onWakeSessionEvent` matches `onEvent` wakes against session lifecycle events
 *   - the `scheduled_wakes` table persists everything so agent-registered wakes
 *     survive restart
 *
 * Delivery is shared with webhook routing through session-manager.deliverToSession,
 * reached via lazy require (session-manager has no static dependency on this module).
 */

import {
  insertScheduledWake, listScheduledWakes, updateScheduledWakeFireAt, deleteScheduledWake,
} from "./db";
import { logActivity } from "./activity";
import type { SessionTriggerEvent } from "./action-types";
import type { HarnessSelf, WakeWhen, WakeHandle } from "./harness-context";

const TICK_MS = 10_000;

type WakeEntry = {
  id: string;
  target: string;
  content: string;
  kind: "at" | "every" | "onEvent";
  fireAt: number | null;
  everyMs: number | null;
  onEvent: SessionTriggerEvent | null;
  cwd?: string;
  userProfile?: string;
  /** onEvent fire counter (in-memory) — backs the runaway-loop safety cap. */
  fires: number;
};

/** id → in-memory wake (source of truth at runtime, backed by the table). */
const wakes = new Map<string, WakeEntry>();

// Cascade guard for onEvent wakes: a per-(wake, session) cooldown plus a hard fire cap.
// An onEvent wake whose spec matches events its own delivery produces (e.g. assistant:end
// every:1 on a tag the delivered session carries) is an intentional loop — bound it so it
// can never tight-loop (cooldown) and can never run forever (cap → auto-cancel).
const ON_EVENT_COOLDOWN_MS = 5_000;
const MAX_ONEVENT_FIRES = 1000;
const lastOnEventFire = new Map<string, number>();

let started = false;
let ticking = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

// ── Lazy delivery (avoid any import cycle with session-manager) ──
function deliver(target: string, content: string): Promise<{ delivered: string[]; missed: boolean }> {
  const sm = require("./session-manager") as typeof import("./session-manager");
  return sm.deliverToSession(target, content);
}

// ── Interval parsing ──
function parseInterval(s: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`wake: invalid interval "${s}" (use e.g. "30s", "5m", "1h", "2d")`);
  const numStr = m[1];
  const unit = m[2];
  if (!numStr || !unit) throw new Error(`wake: invalid interval "${s}"`);
  const n = Number(numStr);
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

function genId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

// ── Public API ──

/** Register a scheduled or event-driven wake. Persisted for restart survival. */
export function scheduleWake(req: {
  self: HarnessSelf;
  target: string;
  content: string;
  when: Exclude<WakeWhen, "now">;
}): WakeHandle {
  const { self, target, content, when } = req;
  const id = `wake-${genId()}`;

  let kind: WakeEntry["kind"];
  let fireAt: number | null = null;
  let everyMs: number | null = null;
  let onEvent: SessionTriggerEvent | null = null;

  if ("at" in when) {
    kind = "at";
    fireAt = Date.parse(when.at);
    if (Number.isNaN(fireAt)) throw new Error(`wake: invalid {at} timestamp "${when.at}"`);
  } else if ("every" in when) {
    kind = "every";
    everyMs = parseInterval(when.every);
    fireAt = Date.now() + everyMs;
  } else {
    kind = "onEvent";
    onEvent = when.onEvent;
  }

  const entry: WakeEntry = { id, target, content, kind, fireAt, everyMs, onEvent, cwd: self.cwd, userProfile: self.userProfile, fires: 0 };
  wakes.set(id, entry);
  insertScheduledWake({
    id, target, content, kind, fireAt, everyMs,
    onEvent: onEvent ? JSON.stringify(onEvent) : null,
    originKind: self.kind, originName: self.name,
    cwd: self.cwd, userProfile: self.userProfile,
  });

  // Lazily ensure the tick loop is running (covers callers that schedule before boot init).
  if (!started) initWakeScheduler();

  logActivity({
    eventType: "harness_wake_scheduled",
    sessionId: self.sessionId ?? undefined,
    summary: `${self.kind}:${self.name} scheduled wake "${target}" (${kind})`,
    metadata: { kind: self.kind, name: self.name, target, wakeKind: kind, fireAt, everyMs },
  });

  return { id, scheduled: true, cancel: () => { cancelWake(id); } };
}

/** Cancel a scheduled wake by id. Returns true if it existed. */
export function cancelWake(id: string): boolean {
  const had = wakes.delete(id);
  deleteScheduledWake(id);
  // Prune this wake's cooldown keys so the map can't leak across cancels.
  for (const key of [...lastOnEventFire.keys()]) {
    if (key.startsWith(`${id}:`)) lastOnEventFire.delete(key);
  }
  return had;
}

/** Start the tick loop and rehydrate persisted wakes. Idempotent. Called at boot. */
export function initWakeScheduler(): void {
  if (started) return;
  started = true;

  for (const row of listScheduledWakes()) {
    if (wakes.has(row.id)) continue;
    wakes.set(row.id, {
      id: row.id,
      target: row.target,
      content: row.content,
      kind: row.kind,
      fireAt: row.fire_at,
      everyMs: row.every_ms,
      onEvent: row.on_event ? (JSON.parse(row.on_event) as SessionTriggerEvent) : null,
      cwd: row.cwd ?? undefined,
      userProfile: row.user_profile ?? undefined,
      fires: 0,
    });
  }

  tickTimer = setInterval(() => { void tick(); }, TICK_MS);
  console.log(`[wake] scheduler started with ${wakes.size} persisted wake(s)`);
}

export function stopWakeScheduler(): void {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  started = false;
  ticking = false;
  // Drop in-memory state so a later init() re-hydrates cleanly from the table.
  wakes.clear();
  lastOnEventFire.clear();
}

// ── Tick (at/every) ──

async function tick(): Promise<void> {
  // Reentrancy guard: setInterval does not await the previous tick, so a delivery
  // that overruns TICK_MS must not let the next interval start a second pass.
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const entry of [...wakes.values()]) {
      if (entry.kind === "onEvent") continue;
      if (entry.fireAt == null || now < entry.fireAt) continue;
      await fireScheduled(entry, now);
    }
  } finally {
    ticking = false;
  }
}

async function fireScheduled(entry: WakeEntry, now: number): Promise<void> {
  // Advance the schedule BEFORE delivering: a slow delivery must not leave this entry
  // due again. For `every`, push fireAt forward now; for `at`, remove it entirely.
  if (entry.kind === "every" && entry.everyMs) {
    entry.fireAt = now + entry.everyMs;
    updateScheduledWakeFireAt(entry.id, entry.fireAt, now);
  } else {
    wakes.delete(entry.id);
    deleteScheduledWake(entry.id);
  }

  try {
    const res = await deliver(entry.target, entry.content);
    logActivity({
      eventType: "harness_wake_fired",
      summary: `wake "${entry.target}" (${entry.kind}) → ${res.delivered.length} session(s)`,
      metadata: { id: entry.id, target: entry.target, kind: entry.kind, delivered: res.delivered, missed: res.missed },
    });
  } catch (err) {
    console.error(`[wake] delivery failed for ${entry.id}:`, err);
  }
}

// ── Event-driven (onEvent) ──

type WakeSessionInfo = {
  id: string;
  userProfile?: string;
  tags: string[];
  preview: string;
  title?: string | null;
  messageCount: number;
  lastResponse?: string;
  assistantSeq?: number;
  assistantMessageUuid?: string;
};

function matchesRound(spec: number | `every:${number}` | `after:${number}`, actual: number): boolean {
  if (typeof spec === "number") return actual === spec;
  if (spec.startsWith("every:")) {
    const n = parseInt(spec.slice(6), 10);
    return n > 0 && actual > 0 && actual % n === 0;
  }
  if (spec.startsWith("after:")) {
    const n = parseInt(spec.slice(6), 10);
    return Number.isFinite(n) && actual >= n;
  }
  return false;
}

function matchesEvent(spec: SessionTriggerEvent, event: SessionTriggerEvent): boolean {
  if (typeof spec === "string") return typeof event === "string" && event === spec;
  if (typeof event === "string") return false;
  // Actual fired events always carry a numeric round (the spec side may use every:/after:).
  if (typeof event.round !== "number") return false;
  return event.role === spec.role && event.at === spec.at && matchesRound(spec.round, event.round);
}

function targetMatchesSession(target: string, session: WakeSessionInfo): boolean {
  return session.id === target || session.tags.includes(target);
}

/** Called by session-manager on each session lifecycle event (mirrors onSessionEvent). */
export function onWakeSessionEvent(event: SessionTriggerEvent, session: WakeSessionInfo): void {
  for (const entry of [...wakes.values()]) {
    if (entry.kind !== "onEvent" || !entry.onEvent) continue;
    if (!matchesEvent(entry.onEvent, event)) continue;
    if (!targetMatchesSession(entry.target, session)) continue;

    // Cooldown: never re-fire the same (wake, session) within the window (tight-loop guard).
    const key = `${entry.id}:${session.id}`;
    const now = Date.now();
    if (now - (lastOnEventFire.get(key) ?? 0) < ON_EVENT_COOLDOWN_MS) continue;
    lastOnEventFire.set(key, now);

    // Hard cap: a self-sustaining onEvent spec (its own delivery produces the matching
    // event) would otherwise re-fire forever on the cooldown cadence. Auto-cancel at the
    // cap so a runaway always terminates and is visible. Use {every} for periodic re-engage.
    entry.fires += 1;
    if (entry.fires > MAX_ONEVENT_FIRES) {
      console.warn(`[wake] onEvent wake ${entry.id} hit the ${MAX_ONEVENT_FIRES}-fire safety cap — auto-cancelling (likely a self-sustaining loop)`);
      logActivity({
        eventType: "harness_wake_capped",
        summary: `onEvent wake ${entry.id} auto-cancelled at ${MAX_ONEVENT_FIRES}-fire cap`,
        metadata: { id: entry.id, target: entry.target, fires: entry.fires },
      });
      cancelWake(entry.id);
      continue;
    }

    // Deliver to the specific session that fired the event.
    void deliver(session.id, entry.content).catch((err) => {
      console.error(`[wake] onEvent delivery failed for ${entry.id} → ${session.id}:`, err);
    });
  }
}

/** Test/inspection helper — current scheduled wake count. */
export function activeWakeCount(): number {
  return wakes.size;
}
