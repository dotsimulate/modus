/**
 * Pure helpers for the session-research move: turn text, truncation, local
 * dates, and the "who is waiting on whom" guess.
 *
 * Kept free of runtime imports so tests can load it without opening a database.
 * The move loader hot-reloads sibling files with context.ts.
 */

import type { TurnContent } from "../../db";

// ── Turn text ──

/**
 * The text an assistant turn ends on: its narration after the last tool call.
 *
 * A turn's `text` joins every narration segment between tool calls, so the
 * answer the user actually read is at the end. An interrupted turn can end on a
 * tool call; the last non-empty segment is the best stand-in.
 */
export function finalText(turn: TurnContent): string {
  const blocks = turn.contentBlocks;
  if (turn.role !== "assistant" || !blocks?.length) return turn.text.trim();
  const segments: string[][] = [[]];
  for (const block of blocks) {
    if (block.type === "tool_call" || block.type === "deferred") {
      segments.push([]);
    } else if (block.type === "text") {
      const text = block.text
        ?? (block.textStart !== undefined ? turn.text.slice(block.textStart, block.textEnd) : "");
      if (text.trim()) segments[segments.length - 1]!.push(text);
    }
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    const joined = segments[i]!.join("").trim();
    if (joined) return joined;
  }
  return turn.text.trim();
}

/**
 * Shorten to `max` characters by cutting the middle, keeping the opening and,
 * with most of the budget, the end — where an assistant turn's conclusion is.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (omitted: number) => `\n[… ${omitted} chars omitted …]\n`;
  const budget = Math.max(0, max - marker(text.length).length);
  const head = Math.floor(budget / 4);
  const tail = budget - head;
  return text.slice(0, head).trimEnd() + marker(text.length - head - tail) + text.slice(text.length - tail).trimStart();
}

// ── Local dates ──

/** The requested IANA time zone if valid, else the harness machine's own. */
export function resolveTimeZone(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() }).resolvedOptions().timeZone;
    } catch { /* fall through to local */ }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function zonedParts(ts: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ts);
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** Offset of `timeZone` from UTC at instant `ts`, in ms. */
function zoneOffset(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of local midnight starting the given calendar day in `timeZone`. */
export function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffset(guess, timeZone);
  // Re-check at the candidate instant so a DST change between the two holds.
  return guess - zoneOffset(first, timeZone);
}

/** `YYYY-MM-DD HH:mm` in `timeZone`. */
export function formatLocal(ts: number | null | undefined, timeZone: string): string {
  if (!ts) return "n/a";
  const p = zonedParts(ts, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month!)}-${pad(p.day!)} ${pad(p.hour!)}:${pad(p.minute!)}`;
}

/** Start of the local day containing `ts`, plus `offsetDays`. */
function localDayStart(ts: number, timeZone: string, offsetDays = 0): number {
  const p = zonedParts(ts, timeZone);
  const shifted = new Date(Date.UTC(p.year!, p.month! - 1, p.day! + offsetDays));
  return localMidnight(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

/**
 * Resolve a date argument to the epoch ms where its local day starts.
 * Accepts `today`, `yesterday`, a calendar date (`2026-10-08`, read in
 * `timeZone`, not UTC), a full ISO timestamp, or epoch ms.
 */
export function parseDateBound(value: unknown, timeZone: string, now = Date.now()): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "today") return localDayStart(now, timeZone);
  if (v === "yesterday") return localDayStart(now, timeZone, -1);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (day) return localMidnight(Number(day[1]), Number(day[2]), Number(day[3]), timeZone);
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? undefined : ts;
}

/** `[start, end)` of one local day named like {@link parseDateBound}. */
export function dayRange(value: unknown, timeZone: string, now = Date.now()): [number, number] | undefined {
  const start = parseDateBound(value, timeZone, now);
  if (start === undefined) return undefined;
  const dayStart = localDayStart(start, timeZone);
  return [dayStart, localDayStart(dayStart, timeZone, 1)];
}

// ── Ending ──

export type Ending = "asks_user" | "waiting_on_external" | "signed_off" | "mid_work";

const ASKS_USER = [
  /\?\s*$/,
  /\b(want me to|should i|shall i|would you like|do you want|let me know|your call|which (one|option|do you)|can you (confirm|test|check|try|run)|waiting (on|for) (you|your))\b/i,
];
const WAITING_EXTERNAL = [
  /\b(waiting (on|for)|watching (for|it|the)|once (the|it|that)|when (the|it) (finishes|lands|completes)|i'?ll (keep )?(watch|check back|monitor|wait)|in the background|still running|polling)\b/i,
];

/** Runtime statuses during which the agent is still producing its turn. */
const WORKING_STATUSES = new Set(["starting", "running", "interrupting"]);

/**
 * A guess at what a session is waiting on, from how its last turn ends and the
 * session's runtime status. Text heuristics only — callers must present it as
 * a guess.
 */
export function classifyEnding(last: TurnContent | undefined, status?: string): Ending {
  if (!last || last.role !== "assistant") return "mid_work";
  if (status && WORKING_STATUSES.has(status)) return "mid_work";
  const tail = finalText(last).slice(-600);
  if (ASKS_USER.some((re) => re.test(tail))) return "asks_user";
  if (WAITING_EXTERNAL.some((re) => re.test(tail))) return "waiting_on_external";
  return "signed_off";
}
