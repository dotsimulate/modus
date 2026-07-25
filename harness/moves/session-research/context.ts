/**
 * Session Research move — gives an agent the ability to search and read
 * past session conversations via API ops.
 *
 * Backend: harness/db.ts searchSessions, getSession, getSessionMessages, listSessionsScoped.
 * Handlers auto-scope to the calling session's cwd/userProfile via getSession lookup.
 */

import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";
import {
  searchSessions,
  listSessions,
  listSessionsScoped,
  parseTags,
} from "../../db";
import type { TurnContent } from "../../../harness/db";

// ── gather() ──

export async function gather(ctx: MoveContext): Promise<string> {
  const project = ctx.cwd.split("/").slice(-2).join("/");
  return `You have access to a session research tool. You can search past conversations, list recent sessions, and read their messages.

Research token: \`${ctx.apiToken}\`
Current project: \`${ctx.cwd}\` (${project})
User profile: \`${ctx.userProfile ?? "none"}\`

## BEFORE YOU START

Call ToolSearch for \`mcp__modus__modus_submit\` to load the schema. Without this step the tool is not callable.

## API (use modus_submit with the token above)

**Search sessions:**
\`{ "op": "search", "query": "deployment pipeline" }\`
\`{ "op": "search", "query": "auth refactor", "limit": 5, "profile": "dev-agent" }\`
\`{ "op": "search", "query": "bootstrap definition", "role": "user" }\` — search only USER messages
\`{ "op": "search", "query": "error handling", "role": "assistant" }\` — search only ASSISTANT messages
\`{ "op": "search", "query": "bullet solver", "dateAfter": "2026-04-01" }\` — only sessions active after a date
\`{ "op": "search", "query": "auth", "dateBefore": "2026-03-15", "dateAfter": "2026-03-01" }\` — date range

**List recent sessions:**
\`{ "op": "list" }\`
\`{ "op": "list", "limit": 10, "profile": "dev-agent" }\`

**Read a session's messages:**
\`{ "op": "read", "sessionId": "abc-123" }\`
\`{ "op": "read", "sessionId": "abc-123", "limit": 10, "offset": 5 }\`
\`{ "op": "read", "sessionId": "abc-123", "role": "user" }\` — read only USER turns
\`{ "op": "read", "sessionId": "abc-123", "role": "user", "maxLength": 5000 }\` — longer turn content

**Scan multiple sessions at once:**
\`{ "op": "scan", "sessionIds": ["id1", "id2", "id3"] }\` — first user turn from each
\`{ "op": "scan", "sessionIds": ["id1", "id2"], "role": "user", "maxLength": 3000 }\`

**Get session metadata:**
\`{ "op": "info", "sessionId": "abc-123" }\`

## How to do thorough research

\`search\` and \`list\` return metadata + snippets only — not session content. To actually know what happened in a session you MUST call \`read\` or \`scan\`.

- Use \`list\` or \`search\` to find candidates
- Use \`scan\` to quickly preview first turns from multiple candidates at once — much faster than reading each one
- Call \`read\` on the most promising sessions for full content
- If a session has many turns, paginate with \`offset\` until you've covered it
- Results exclude archived and internal sessions
- Synthesize from content, not from snippets

## Search tips

- The \`role\` filter is critical: if looking for something the USER wrote, always use \`role: "user"\`
- Use \`dateAfter\`/\`dateBefore\` to narrow by timeframe (ISO date strings)
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

function formatTurn(t: TurnContent, maxLen: number): string {
  const prefix = t.role === "user" ? "USER" : "ASSISTANT";
  const text = truncate(t.text.trim(), maxLen);
  const toolSummary = t.toolCalls?.length
    ? ` [${t.toolCalls.length} tool call${t.toolCalls.length > 1 ? "s" : ""}: ${t.toolCalls.map(tc => tc.name).join(", ")}]`
    : "";
  return `[${prefix}]${toolSummary}\n${text}`;
}

function parseDate(val: unknown): number | undefined {
  if (typeof val === "string") {
    const ts = Date.parse(val);
    return isNaN(ts) ? undefined : ts;
  }
  if (typeof val === "number") return val;
  return undefined;
}

// ── Handlers ──

export const handlers: Record<string, MoveApiHandler> = {

  search: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const query = typeof data.query === "string" ? data.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };

    const requestedLimit = clampNum(data.limit, 10, 50);
    const profile = typeof data.profile === "string" ? data.profile : undefined;
    const role = typeof data.role === "string" && ["user", "assistant"].includes(data.role) ? data.role : undefined;
    const dateAfter = parseDate(data.dateAfter);
    const dateBefore = parseDate(data.dateBefore);
    const hasDateFilter = dateAfter !== undefined || dateBefore !== undefined;
    const caller = getCallerScope(ctx);

    // If date filtering, fetch more from backend so post-filter has enough to work with
    const fetchLimit = hasDateFilter ? Math.min(requestedLimit * 5, 50) : requestedLimit;

    const scope: Parameters<typeof searchSessions>[2] = {
      ...(caller.cwd ? { cwdPrefixes: [caller.cwd] } : {}),
      ...(caller.userProfile ? { userProfileName: caller.userProfile } : {}),
      ...(profile ? { agentProfiles: [profile] } : {}),
      ...(role ? { role } : {}),
    };
    let hits = searchSessions(query, fetchLimit, Object.keys(scope).length ? scope : undefined);

    // Post-filter by date range
    if (dateAfter !== undefined) {
      hits = hits.filter(h => h.last_message_at >= dateAfter);
    }
    if (dateBefore !== undefined) {
      hits = hits.filter(h => h.last_message_at <= dateBefore);
    }
    hits = hits.slice(0, requestedLimit);

    if (hits.length === 0) {
      return { ok: true, message: `No sessions found for "${query}"` };
    }

    // Build richer output: for each hit, grab the best matching turn content
    const lines = [`Found ${hits.length} session${hits.length > 1 ? "s" : ""} for "${query}":\n`];
    for (const hit of hits) {
      const date = new Date(hit.last_message_at).toISOString().split("T")[0];
      lines.push(`- **${hit.session_id}** [${hit.profile ?? "no-profile"}] ${date} $${hit.total_cost_usd.toFixed(2)}`);
      lines.push(`  ${truncate(hit.preview, 120)}`);

      // Get a richer snippet: find the best matching turn and show more context
      try {
        const turns = ctx.db.getSessionMessages(hit.session_id);
        const targetTurns = role ? turns.filter(t => t.role === role) : turns;
        const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
        let bestTurn: TurnContent | undefined;
        let bestScore = 0;
        for (const t of targetTurns) {
          const lower = t.text.toLowerCase();
          const score = queryTerms.reduce((s, term) => s + (lower.includes(term) ? 1 : 0), 0);
          if (score > bestScore) { bestScore = score; bestTurn = t; }
        }
        if (bestTurn) {
          const lower = bestTurn.text.toLowerCase();
          const idx = lower.indexOf(queryTerms[0] ?? "");
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
    const caller = getCallerScope(ctx);

    // Build scope from caller context + optional profile filter
    const scopeOpts: Parameters<typeof listSessionsScoped>[0] = { limit };
    if (caller.cwd) scopeOpts.cwdPrefixes = [caller.cwd];
    if (caller.userProfile) scopeOpts.userProfileName = caller.userProfile;
    if (profile) scopeOpts.agentProfiles = [profile];

    // listSessionsScoped requires at least one filter — fallback to listSessions
    const hasFilter = scopeOpts.cwdPrefixes || scopeOpts.userProfileName || scopeOpts.agentProfiles;
    const sessions = hasFilter
      ? listSessionsScoped(scopeOpts)
      : listSessions(limit);

    if (sessions.length === 0) {
      return { ok: true, message: "No sessions found." };
    }

    const lines = [`${sessions.length} recent session${sessions.length > 1 ? "s" : ""}:\n`];
    for (const s of sessions) {
      const date = new Date(s.last_message_at ?? s.updated_at).toISOString().split("T")[0];
      const tags = parseTags(s.tags).filter(t => t !== "archived" && t !== "internal");
      const tagStr = tags.length ? ` [${tags.join(", ")}]` : "";
      lines.push(`- **${s.id}** [${s.profile ?? "?"}] ${s.status} ${date} $${s.total_cost_usd.toFixed(2)}${tagStr}`);
      lines.push(`  ${truncate(s.preview, 120)}`);
    }

    return { ok: true, message: lines.join("\n") };
  },

  read: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const session = ctx.db.getSession(sessionId);
    if (!session) return { ok: false, error: `Session "${sessionId}" not found` };

    const limit = clampNum(data.limit, 30, 100);
    const offset = typeof data.offset === "number" ? Math.max(0, Math.floor(data.offset)) : 0;
    const role = typeof data.role === "string" && ["user", "assistant"].includes(data.role) ? data.role : undefined;
    const maxLength = clampNum(data.maxLength, 3000, 8000);

    const allTurns = ctx.db.getSessionMessages(sessionId);
    const filtered = role ? allTurns.filter(t => t.role === role) : allTurns;
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

  scan: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionIds = Array.isArray(data.sessionIds) ? data.sessionIds.filter((s): s is string => typeof s === "string") : [];
    if (sessionIds.length === 0) return { ok: false, error: "sessionIds array is required (list of session IDs to scan)" };
    if (sessionIds.length > 20) return { ok: false, error: "Max 20 sessions per scan" };

    const role = typeof data.role === "string" && ["user", "assistant"].includes(data.role) ? data.role : undefined;
    const maxLength = clampNum(data.maxLength, 2000, 5000);
    const lines: string[] = [`Scanning ${sessionIds.length} sessions${role ? ` (${role} turns only)` : ""}:\n`];

    for (const sid of sessionIds) {
      const session = ctx.db.getSession(sid);
      if (!session) {
        lines.push(`--- **${sid}** — NOT FOUND ---\n`);
        continue;
      }
      const date = new Date(session.last_message_at ?? session.updated_at ?? 0).toISOString().split("T")[0];
      lines.push(`--- **${sid}** [${session.profile ?? "?"}] ${date} $${(session.total_cost_usd ?? 0).toFixed(2)} ---`);
      if (session.title) lines.push(`Title: ${session.title}`);

      const allTurns = ctx.db.getSessionMessages(sid);
      const filtered = role ? allTurns.filter(t => t.role === role) : allTurns;
      const preview = filtered.slice(0, 3); // First 3 turns

      if (preview.length === 0) {
        lines.push(`(no ${role ?? ""} turns)`);
      } else {
        const perTurn = Math.min(maxLength, Math.floor(6000 / preview.length));
        for (const turn of preview) {
          lines.push(formatTurn(turn, perTurn));
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

    const tags = parseTags(s.tags ?? "");
    const created = new Date(s.created_at ?? 0).toISOString();
    const updated = new Date(s.updated_at ?? 0).toISOString();
    const lastMsg = s.last_message_at ? new Date(s.last_message_at).toISOString() : "n/a";

    const lines = [
      `**${s.id}**`,
      `Profile: ${s.profile ?? "none"}`,
      `Provider: ${s.provider ?? "unknown"}`,
      `Model: ${s.model ?? "unknown"}`,
      `Status: ${s.status}`,
      `Messages: ${s.message_count}`,
      `Cost: $${(s.total_cost_usd ?? 0).toFixed(4)}`,
      `Created: ${created}`,
      `Updated: ${updated}`,
      `Last message: ${lastMsg}`,
      `CWD: ${s.cwd ?? "unknown"}`,
      `Tags: ${tags.length ? tags.join(", ") : "none"}`,
    ];

    if (s.title) lines.push(`Title: ${s.title}`);
    if (s.parent_session_id) lines.push(`Forked from: ${s.parent_session_id}`);
    if (s.preview) lines.push(`\nPreview: ${truncate(s.preview, 200)}`);

    return { ok: true, message: lines.join("\n") };
  },
};
