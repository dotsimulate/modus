/**
 * Session Research move — gives an agent the ability to search and read
 * past session conversations via API ops.
 *
 * Backend: harness/db.ts searchSessions, getSession, listSessionsScoped; turns via
 * ctx.db.readSessionMessages, which rebuilds them on a worker thread.
 * Handlers auto-scope to the calling session's cwd/userProfile via getSession lookup.
 * Dates are shown and parsed in a local time zone (the `timeZone` arg, else the machine's).
 */

import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";
import {
  getSession,
  searchSessions,
  searchSessionsOffThread,
  listSessions,
  listSessionsScoped,
  parseTags,
} from "../../db";
import type { SessionRow, TurnContent } from "../../../harness/db";
import {
  classifyEnding,
  clip,
  dayRange,
  finalText,
  formatLocal,
  parseDateBound,
  resolveTimeZone,
} from "./turns";

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  const project = ctx.cwd.split("/").slice(-2).join("/");
  return `You have access to a session research tool. You can search past conversations, list recent sessions, and read their messages.

Research token: \`${ctx.apiToken}\`
Current project: \`${ctx.cwd}\` (${project})
User profile: \`${ctx.userProfile ?? "none"}\`
Time zone: \`${resolveTimeZone(undefined)}\` — all dates shown and accepted are local to it (override per call with \`timeZone\`)

## BEFORE YOU START

Call ToolSearch for \`mcp__modus__modus_submit\` to load the schema. Without this step the tool is not callable.

## API (use modus_submit with the token above)

**Check in on many sessions at once (what's left hanging):**
\`{ "op": "digest", "date": "today" }\` — one row per session: last user message, last assistant final answer, who spoke last, and a guessed ending
\`{ "op": "digest", "sessionIds": ["id1", "id2"] }\`

**Read how a session ended:**
\`{ "op": "tail", "sessionId": "abc-123" }\` — last 2 turns; assistant turns cut to their final answer
\`{ "op": "tail", "sessionId": "abc-123", "turns": 6, "full": true }\` — keep all narration

**Search sessions:**
\`{ "op": "search", "query": "deployment pipeline" }\`
\`{ "op": "search", "query": "auth refactor", "limit": 5, "profile": "dev-agent" }\`
\`{ "op": "search", "query": "bootstrap definition", "role": "user" }\` — search only USER messages
\`{ "op": "search", "query": "error handling", "role": "assistant" }\` — search only ASSISTANT messages
\`{ "op": "search", "query": "bullet solver", "date": "yesterday" }\` — one local day
\`{ "op": "search", "query": "auth", "dateAfter": "2026-03-01", "dateBefore": "2026-03-15" }\` — date range

**List recent sessions:**
\`{ "op": "list" }\`
\`{ "op": "list", "date": "today" }\`
\`{ "op": "list", "limit": 10, "profile": "dev-agent" }\`

**Read a session's messages:**
\`{ "op": "read", "sessionId": "abc-123" }\`
\`{ "op": "read", "sessionId": "abc-123", "limit": 10, "offset": 5 }\`
\`{ "op": "read", "sessionId": "abc-123", "offset": -4 }\` — negative offset counts from the end
\`{ "op": "read", "sessionId": "abc-123", "role": "user" }\` — read only USER turns
\`{ "op": "read", "sessionId": "abc-123", "role": "user", "maxLength": 5000 }\` — longer turn content

**Scan multiple sessions at once:**
\`{ "op": "scan", "sessionIds": ["id1", "id2", "id3"] }\` — first 3 turns from each
\`{ "op": "scan", "sessionIds": ["id1", "id2"], "from": "end" }\` — last 3 turns from each

**Get session metadata:**
\`{ "op": "info", "sessionId": "abc-123" }\`

## How to do thorough research

\`search\` and \`list\` return metadata + snippets only — not session content. To actually know what happened in a session you MUST call \`read\`, \`tail\`, \`scan\`, or \`digest\`.

- Use \`list\` or \`search\` to find candidates
- Use \`digest\` or \`scan\` to preview many candidates in one call
- Call \`read\` on the most promising sessions for full content
- Turn counts are the same number everywhere, so \`read\` offsets line up with \`list\`/\`info\`
- Long turns are cut in the middle, never at the end, so a final answer is always shown
- Results exclude archived and internal sessions, and \`list\`/\`digest\` skip sessions with no turns
- \`digest\`'s ending is a text heuristic — verify before acting on it
- Synthesize from content, not from snippets

## Search tips

- The \`role\` filter is critical: if looking for something the USER wrote, always use \`role: "user"\`
- Use \`date\` or \`dateAfter\`/\`dateBefore\` to narrow by timeframe
- When no session contains every word, search falls back to sessions matching some of them and says so
- Search returns up to 400-char snippets of matching content — enough to judge relevance
- If search returns too many irrelevant results after 5 attempts, STOP and ask the user for unique phrases or timeframe
- Do NOT burn 50 searches with slight variations — diminishing returns hit fast`;
}

// ── Scope from calling session ──

function getCallerScope(ctx: MoveApiContext): { cwd?: string; userProfile?: string } {
  const s = ctx.db.getSession(ctx.sessionId);
  return { cwd: s?.cwd ?? undefined, userProfile: s?.user_profile ?? undefined };
}

// ── Helpers ──

function clampNum(val: unknown, def: number, max: number): number {
  const n = typeof val === "number" ? val : def;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function roleArg(val: unknown): "user" | "assistant" | undefined {
  return val === "user" || val === "assistant" ? val : undefined;
}

function formatTurn(t: TurnContent, maxLen: number, opts: { finalOnly?: boolean } = {}): string {
  const prefix = t.role === "user" ? "USER" : t.role === "system" ? "SYSTEM" : "ASSISTANT";
  const text = clip(opts.finalOnly ? finalText(t) : t.text.trim(), maxLen);
  const toolSummary = t.toolCalls?.length
    ? ` [${t.toolCalls.length} tool call${t.toolCalls.length > 1 ? "s" : ""}: ${t.toolCalls.map(tc => tc.name).join(", ")}]`
    : "";
  const label = opts.finalOnly && t.role === "assistant" && t.toolCalls?.length ? " (final answer)" : "";
  return `[${prefix}]${toolSummary}${label}\n${text}`;
}

/**
 * A session's turns, rebuilt off the harness's main thread: an op here can read
 * dozens of long transcripts, and reading them inline stalls every other request
 * — the UI, live streams, dictation uploads — until it finishes. No op shows
 * tool inputs or results, so they are not carried back.
 */
async function turnsOf(ctx: MoveApiContext, sessionId: string): Promise<TurnContent[]> {
  try {
    // A backend older than this move has only the synchronous read.
    return typeof ctx.db.readSessionMessages === "function"
      ? await ctx.db.readSessionMessages(sessionId, { toolPayloads: false })
      : ctx.db.getSessionMessages(sessionId);
  } catch {
    return [];
  }
}

type DateWindow = { after?: number; before?: number; label: string };

/** `date` names one local day; `dateAfter`/`dateBefore` bound a range. */
function dateWindow(data: Record<string, unknown>, timeZone: string): DateWindow | { error: string } {
  if (data.date !== undefined) {
    const range = dayRange(data.date, timeZone);
    if (!range) return { error: `Unrecognized date "${String(data.date)}" — use today, yesterday, or YYYY-MM-DD` };
    return { after: range[0], before: range[1], label: ` on ${formatLocal(range[0], timeZone).slice(0, 10)}` };
  }
  const after = parseDateBound(data.dateAfter, timeZone);
  const before = parseDateBound(data.dateBefore, timeZone);
  if (data.dateAfter !== undefined && after === undefined) return { error: `Unrecognized dateAfter "${String(data.dateAfter)}"` };
  if (data.dateBefore !== undefined && before === undefined) return { error: `Unrecognized dateBefore "${String(data.dateBefore)}"` };
  const parts = [
    after !== undefined ? `after ${formatLocal(after, timeZone)}` : "",
    before !== undefined ? `before ${formatLocal(before, timeZone)}` : "",
  ].filter(Boolean);
  return { after, before, label: parts.length ? ` ${parts.join(" and ")}` : "" };
}

function inWindow(ts: number | null | undefined, w: DateWindow): boolean {
  const t = ts ?? 0;
  return (w.after === undefined || t >= w.after) && (w.before === undefined || t < w.before);
}

/** Sessions in the caller's scope, newest activity first. */
function listScoped(
  ctx: MoveApiContext,
  opts: { limit: number; profile?: string; window: DateWindow },
): SessionRow[] {
  const caller = getCallerScope(ctx);
  const scopeOpts: Parameters<typeof listSessionsScoped>[0] = {
    limit: opts.limit,
    lastMessageAfter: opts.window.after,
    lastMessageBefore: opts.window.before,
  };
  if (caller.cwd) scopeOpts.cwdPrefixes = [caller.cwd];
  if (caller.userProfile) scopeOpts.userProfileName = caller.userProfile;
  if (opts.profile) scopeOpts.agentProfiles = [opts.profile];

  // listSessionsScoped requires at least one filter — fallback to listSessions
  const hasFilter = scopeOpts.cwdPrefixes || scopeOpts.userProfileName || scopeOpts.agentProfiles;
  const sessions = hasFilter ? listSessionsScoped(scopeOpts) : listSessions(opts.limit);
  // The unscoped fallback has no date bounds, and a backend bundle built before
  // listSessionsScoped took them ignores them, so apply the window here too.
  return sessions.filter(s => inWindow(s.last_message_at ?? s.updated_at, opts.window));
}

function lastOf(turns: TurnContent[], role: "user" | "assistant"): TurnContent | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i]!.role === role) return turns[i];
  return undefined;
}

const ENDING_LABEL: Record<ReturnType<typeof classifyEnding>, string> = {
  asks_user: "asks_user — last turn asks you something",
  waiting_on_external: "waiting_on_external — said it is waiting on a build, job, or event",
  signed_off: "signed_off — finished turn, no open question",
  mid_work: "mid_work — agent is still working or has not replied",
};

// ── Handlers ──

export const handlers: Record<string, MoveApiHandler> = {

  search: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const query = typeof data.query === "string" ? data.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };

    const requestedLimit = clampNum(data.limit, 10, 50);
    const profile = typeof data.profile === "string" ? data.profile : undefined;
    const role = roleArg(data.role);
    const timeZone = resolveTimeZone(data.timeZone);
    const window = dateWindow(data, timeZone);
    if ("error" in window) return { ok: false, error: window.error };
    const hasDateFilter = window.after !== undefined || window.before !== undefined;
    const caller = getCallerScope(ctx);

    // Over-fetch when date filtering so the post-filter below (for a backend
    // bundle that predates search date bounds) still has enough to work with.
    const fetchLimit = hasDateFilter ? Math.min(requestedLimit * 5, 200) : requestedLimit;

    const scope: Parameters<typeof searchSessions>[2] = {
      ...(caller.cwd ? { cwdPrefixes: [caller.cwd] } : {}),
      ...(caller.userProfile ? { userProfileName: caller.userProfile } : {}),
      ...(profile ? { agentProfiles: [profile] } : {}),
      ...(role ? { role } : {}),
      ...(window.after !== undefined ? { lastMessageAfter: window.after } : {}),
      ...(window.before !== undefined ? { lastMessageBefore: window.before } : {}),
    };
    // Full-text ranking can take hundreds of milliseconds on a large index;
    // run it off the main thread when this backend can.
    const search = typeof searchSessionsOffThread === "function" ? searchSessionsOffThread : searchSessions;
    const run = async (q: string) => (await search(q, fetchLimit, Object.keys(scope).length ? scope : undefined))
      .filter(h => inWindow(h.last_message_at, window));

    let hits = (await run(query)).slice(0, requestedLimit);
    const matchedTerms = new Map<string, number>();

    // Every word must match for a hit. Remembered wording rarely matches the
    // transcript exactly, so when that finds too little, rank sessions by how
    // many of the words they contain.
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [])];
    let partial = false;
    if (hits.length < requestedLimit && words.length > 1 && !query.includes('"')) {
      const seen = new Set(hits.map(h => h.session_id));
      const extra = new Map<string, { hit: (typeof hits)[number]; count: number }>();
      for (const word of words) {
        for (const hit of await run(word)) {
          if (seen.has(hit.session_id)) continue;
          const entry = extra.get(hit.session_id);
          if (entry) entry.count++;
          else extra.set(hit.session_id, { hit, count: 1 });
        }
      }
      const ranked = [...extra.values()]
        .sort((a, b) => b.count - a.count || b.hit.last_message_at - a.hit.last_message_at)
        .slice(0, requestedLimit - hits.length);
      for (const { hit, count } of ranked) matchedTerms.set(hit.session_id, count);
      partial = ranked.length > 0;
      hits = [...hits, ...ranked.map(r => r.hit)];
    }

    if (hits.length === 0) {
      return { ok: true, message: `No sessions found for "${query}"${window.label}` };
    }

    const exactCount = hits.length - matchedTerms.size;
    const lines = [`Found ${hits.length} session${hits.length > 1 ? "s" : ""} for "${query}"${window.label}:`];
    if (partial) lines.push(`(${exactCount} match every word; the rest match some of the words, marked with how many)`);
    lines.push("");
    for (const hit of hits) {
      const partialMark = matchedTerms.has(hit.session_id) ? ` (matches ${matchedTerms.get(hit.session_id)} of ${words.length} words)` : "";
      lines.push(`- **${hit.session_id}** [${hit.profile ?? "no-profile"}] ${formatLocal(hit.last_message_at, timeZone)} $${hit.total_cost_usd.toFixed(2)}${partialMark}`);
      lines.push(`  ${truncate(hit.preview, 120)}`);

      // Get a richer snippet: find the best matching turn and show more context
      try {
        const turns = await turnsOf(ctx, hit.session_id);
        const targetTurns = role ? turns.filter(t => t.role === role) : turns;
        let bestTurn: TurnContent | undefined;
        let bestScore = 0;
        for (const t of targetTurns) {
          const lower = t.text.toLowerCase();
          const score = words.reduce((s, term) => s + (lower.includes(term) ? 1 : 0), 0);
          if (score > bestScore) { bestScore = score; bestTurn = t; }
        }
        if (bestTurn) {
          const lower = bestTurn.text.toLowerCase();
          const idx = words.map(w => lower.indexOf(w)).filter(i => i >= 0).sort((a, b) => a - b)[0] ?? -1;
          let snippet: string;
          if (idx >= 0) {
            const start = Math.max(0, idx - 100);
            snippet = (start > 0 ? "..." : "") + bestTurn.text.slice(start, start + 400).trim();
            if (start + 400 < bestTurn.text.length) snippet += "...";
          } else {
            snippet = truncate(bestTurn.text.trim(), 400);
          }
          lines.push(`  > [${bestTurn.role}] ${snippet}`);
        }
      } catch { /* fallback — no rich snippet */ }
    }

    return { ok: true, message: lines.join("\n") };
  },

  list: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const limit = clampNum(data.limit, 15, 50);
    const profile = typeof data.profile === "string" ? data.profile : undefined;
    const timeZone = resolveTimeZone(data.timeZone);
    const window = dateWindow(data, timeZone);
    if ("error" in window) return { ok: false, error: window.error };
    const includeEmpty = data.includeEmpty === true;

    // Over-fetch so dropping empty sessions still fills the page.
    const fetched = listScoped(ctx, { limit: includeEmpty ? limit : Math.min(limit * 2, 200), profile, window });
    const rows: { s: SessionRow; turns: number }[] = [];
    for (const s of fetched) {
      if (rows.length >= limit) break;
      const turns = (await turnsOf(ctx, s.id)).length;
      if (turns === 0 && !includeEmpty) continue;
      rows.push({ s, turns });
    }

    if (rows.length === 0) {
      return { ok: true, message: `No sessions found${window.label}.` };
    }

    const lines = [`${rows.length} session${rows.length > 1 ? "s" : ""}${window.label} (times in ${timeZone}):\n`];
    for (const { s, turns } of rows) {
      const tags = parseTags(s.tags).filter(t => t !== "archived" && t !== "internal");
      const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
      const self = s.id === ctx.sessionId ? " (this session)" : "";
      lines.push(`- **${s.id}**${self} [${s.profile ?? "?"}] ${s.status} ${formatLocal(s.last_message_at ?? s.updated_at, timeZone)} ${turns} turns $${s.total_cost_usd.toFixed(2)}${tagStr}`);
      lines.push(`  ${truncate(s.title || s.preview, 120)}`);
    }

    return { ok: true, message: lines.join("\n") };
  },

  read: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const session = ctx.db.getSession(sessionId);
    if (!session) return { ok: false, error: `Session "${sessionId}" not found` };

    const limit = clampNum(data.limit, 30, 100);
    const role = roleArg(data.role);
    const maxLength = clampNum(data.maxLength, 3000, 8000);

    const allTurns = await turnsOf(ctx, sessionId);
    const filtered = role ? allTurns.filter(t => t.role === role) : allTurns;
    // A negative offset counts back from the end, so -2 reads the last two turns.
    const rawOffset = typeof data.offset === "number" ? Math.floor(data.offset) : 0;
    const offset = rawOffset < 0 ? Math.max(0, filtered.length + rawOffset) : rawOffset;
    const sliced = filtered.slice(offset, offset + limit);

    if (sliced.length === 0) {
      const total = role ? `${filtered.length} ${role} turns (${allTurns.length} total)` : `${allTurns.length} turns total`;
      return { ok: true, message: `Session "${sessionId}" has ${total}. Offset ${offset} is past the end.` };
    }

    // Scale per-turn length based on how many turns, up to maxLength per turn
    const maxTurnLen = Math.min(maxLength, Math.floor(20000 / sliced.length));
    const roleLabel = role ? ` (${role} only)` : "";
    const lines = [
      `Session: ${sessionId} | ${session.profile ?? "no-profile"} | ${filtered.length}${role ? ` ${role}` : ""} turns${role ? ` (${allTurns.length} total)` : ""}`,
      `Showing turns ${offset + 1}–${offset + sliced.length} of ${filtered.length}${roleLabel}\n`,
    ];

    for (const turn of sliced) {
      lines.push(formatTurn(turn, maxTurnLen));
      lines.push(""); // blank line between turns
    }

    return { ok: true, message: lines.join("\n") };
  },

  tail: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const session = ctx.db.getSession(sessionId);
    if (!session) return { ok: false, error: `Session "${sessionId}" not found` };

    const count = clampNum(data.turns, 2, 20);
    const maxLength = clampNum(data.maxLength, 4000, 8000);
    const full = data.full === true;
    const timeZone = resolveTimeZone(data.timeZone);

    const allTurns = await turnsOf(ctx, sessionId);
    if (allTurns.length === 0) return { ok: true, message: `Session "${sessionId}" has no turns.` };
    const start = Math.max(0, allTurns.length - count);
    const last = allTurns[allTurns.length - 1]!;

    const lines = [
      `Session: ${sessionId} | ${session.profile ?? "no-profile"} | ${session.status} | ${allTurns.length} turns | last activity ${formatLocal(session.last_message_at, timeZone)} (${timeZone})`,
      ...(session.title ? [`Title: ${session.title}`] : []),
      `Last spoke: ${last.role} | Ending (guess): ${ENDING_LABEL[classifyEnding(last, session.status)]}`,
      `Showing turns ${start + 1}–${allTurns.length}${full ? "" : " (assistant turns cut to their final answer)"}\n`,
    ];
    for (const turn of allTurns.slice(start)) {
      lines.push(formatTurn(turn, maxLength, { finalOnly: !full }));
      lines.push("");
    }

    return { ok: true, message: lines.join("\n") };
  },

  digest: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const timeZone = resolveTimeZone(data.timeZone);
    const maxLength = clampNum(data.maxLength, 800, 4000);
    const ids = Array.isArray(data.sessionIds) ? data.sessionIds.filter((s): s is string => typeof s === "string") : [];
    if (ids.length > 100) return { ok: false, error: "Max 100 sessions per digest" };

    let sessions: SessionRow[];
    let heading: string;
    if (ids.length > 0) {
      sessions = ids.flatMap(id => {
        const s = getSession(id);
        return s ? [s] : [];
      });
      heading = `Digest of ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    } else {
      const window = dateWindow(data, timeZone);
      if ("error" in window) return { ok: false, error: window.error };
      if (window.after === undefined && window.before === undefined) {
        return { ok: false, error: "Pass sessionIds, or a date / dateAfter / dateBefore window" };
      }
      const profile = typeof data.profile === "string" ? data.profile : undefined;
      sessions = listScoped(ctx, { limit: clampNum(data.limit, 50, 100), profile, window });
      heading = `Digest of sessions${window.label}`;
    }

    const counts: Record<string, number> = {};
    const blocks: string[] = [];
    for (const s of sessions) {
      const turns = await turnsOf(ctx, s.id);
      if (turns.length === 0 && ids.length === 0) continue;
      const last = turns[turns.length - 1];
      const ending = classifyEnding(last, s.status);
      counts[ending] = (counts[ending] ?? 0) + 1;
      const lastUser = lastOf(turns, "user");
      const lastAssistant = lastOf(turns, "assistant");
      const self = s.id === ctx.sessionId ? " (this session)" : "";
      blocks.push([
        `--- **${s.id}**${self} [${s.profile ?? "?"}] ${s.status} | ${turns.length} turns | ${formatLocal(s.created_at, timeZone)} → ${formatLocal(s.last_message_at ?? s.updated_at, timeZone)}`,
        ...(s.title ? [`Title: ${s.title}`] : []),
        `CWD: ${s.cwd ?? "unknown"}`,
        `Last spoke: ${last?.role ?? "nobody"} | Ending (guess): ${ending}`,
        `[LAST USER] ${lastUser ? clip(lastUser.text.trim(), Math.floor(maxLength / 2)) : "(none)"}`,
        `[LAST ASSISTANT, final answer] ${lastAssistant ? clip(finalText(lastAssistant), maxLength) : "(none)"}`,
        "",
      ].join("\n"));
    }

    if (blocks.length === 0) return { ok: true, message: `${heading}: no sessions with turns.` };

    const tally = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(", ");
    return {
      ok: true,
      message: [
        `${heading} — ${blocks.length} session${blocks.length === 1 ? "" : "s"}, times in ${timeZone}`,
        `Endings (text heuristic, verify before acting): ${tally}`,
        "",
        ...blocks,
      ].join("\n"),
    };
  },

  scan: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionIds = Array.isArray(data.sessionIds) ? data.sessionIds.filter((s): s is string => typeof s === "string") : [];
    if (sessionIds.length === 0) return { ok: false, error: "sessionIds array is required (list of session IDs to scan)" };
    if (sessionIds.length > 20) return { ok: false, error: "Max 20 sessions per scan" };

    const role = roleArg(data.role);
    const fromEnd = data.from === "end";
    const maxLength = clampNum(data.maxLength, 2000, 5000);
    const timeZone = resolveTimeZone(data.timeZone);
    const lines: string[] = [`Scanning ${sessionIds.length} sessions${role ? ` (${role} turns only)` : ""}, ${fromEnd ? "last" : "first"} 3 turns each:\n`];

    for (const sid of sessionIds) {
      const session = ctx.db.getSession(sid);
      if (!session) {
        lines.push(`--- **${sid}** — NOT FOUND ---\n`);
        continue;
      }
      lines.push(`--- **${sid}** [${session.profile ?? "?"}] ${formatLocal(session.last_message_at ?? session.updated_at, timeZone)} $${(session.total_cost_usd ?? 0).toFixed(2)} ---`);
      if (session.title) lines.push(`Title: ${session.title}`);

      const allTurns = await turnsOf(ctx, sid);
      const filtered = role ? allTurns.filter(t => t.role === role) : allTurns;
      const preview = fromEnd ? filtered.slice(-3) : filtered.slice(0, 3);

      if (preview.length === 0) {
        lines.push(`(no ${role ?? ""} turns)`);
      } else {
        const perTurn = Math.min(maxLength, Math.floor(6000 / preview.length));
        for (const turn of preview) {
          lines.push(formatTurn(turn, perTurn, { finalOnly: fromEnd }));
        }
      }
      lines.push(`[${filtered.length} ${role ?? "total"} turns in session]\n`);
    }

    return { ok: true, message: lines.join("\n") };
  },

  info: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const s = ctx.db.getSession(sessionId);
    if (!s) return { ok: false, error: `Session "${sessionId}" not found` };

    const timeZone = resolveTimeZone(data.timeZone);
    const tags = parseTags(s.tags ?? "");
    const turnCount = (await turnsOf(ctx, sessionId)).length;

    const lines = [
      `**${s.id}**`,
      `Profile: ${s.profile ?? "none"}`,
      `Provider: ${s.provider ?? "unknown"}`,
      `Model: ${s.model ?? "unknown"}`,
      `Status: ${s.status}`,
      // Same count `read` pages over; the stored message_count is a different unit.
      `Turns: ${turnCount}`,
      `Cost: $${(s.total_cost_usd ?? 0).toFixed(4)}`,
      `Created: ${formatLocal(s.created_at, timeZone)}`,
      `Updated: ${formatLocal(s.updated_at, timeZone)}`,
      `Last message: ${formatLocal(s.last_message_at, timeZone)}`,
      `Time zone: ${timeZone}`,
      `CWD: ${s.cwd ?? "unknown"}`,
      `Tags: ${tags.length ? tags.join(", ") : "none"}`,
    ];

    if (s.title) lines.push(`Title: ${s.title}`);
    if (s.parent_session_id) lines.push(`Forked from: ${s.parent_session_id}`);
    if (s.preview) lines.push(`\nPreview: ${truncate(s.preview, 200)}`);

    return { ok: true, message: lines.join("\n") };
  },
};
