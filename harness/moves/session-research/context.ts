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
} from "../../../harness/db";
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

**List recent sessions:**
\`{ "op": "list" }\`
\`{ "op": "list", "limit": 10, "profile": "dev-agent" }\`

**Read a session's messages:**
\`{ "op": "read", "sessionId": "abc-123" }\`
\`{ "op": "read", "sessionId": "abc-123", "limit": 10, "offset": 5 }\`

**Get session metadata:**
\`{ "op": "info", "sessionId": "abc-123" }\`

## How to do thorough research

\`search\` and \`list\` return metadata + 120-char snippets only — not session content. To actually know what happened in a session you MUST call \`read\`.

- Use \`list\` or \`search\` to find candidates
- Call \`read\` on each relevant session — this is required, not optional
- If a session has many turns, paginate with \`offset\` until you've covered it
- A thorough research task typically needs 10–20+ calls: list, read, paginate, repeat
- Results exclude archived and internal sessions
- Synthesize from content, not from snippets`;
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

// ── Handlers ──

export const handlers: Record<string, MoveApiHandler> = {

  search: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const query = typeof data.query === "string" ? data.query.trim() : "";
    if (!query) return { ok: false, error: "query is required" };

    const limit = clampNum(data.limit, 10, 50);
    const profile = typeof data.profile === "string" ? data.profile : undefined;
    const caller = getCallerScope(ctx);

    const scope: Parameters<typeof searchSessions>[2] = {
      ...(caller.cwd ? { cwdPrefixes: [caller.cwd] } : {}),
      ...(caller.userProfile ? { userProfileName: caller.userProfile } : {}),
      ...(profile ? { agentProfiles: [profile] } : {}),
    };
    const hits = searchSessions(query, limit, Object.keys(scope).length ? scope : undefined);

    if (hits.length === 0) {
      return { ok: true, message: `No sessions found for "${query}"` };
    }

    const lines = [`Found ${hits.length} session${hits.length > 1 ? "s" : ""} for "${query}":\n`];
    for (const hit of hits) {
      const date = new Date(hit.last_message_at).toISOString().split("T")[0];
      lines.push(`- **${hit.session_id}** [${hit.profile ?? "no-profile"}] ${date} $${hit.total_cost_usd.toFixed(2)}`);
      lines.push(`  ${truncate(hit.preview, 120)}`);
      if (hit.snippet && hit.snippet !== hit.preview) {
        lines.push(`  > ${truncate(hit.snippet, 150)}`);
      }
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

    const allTurns = ctx.db.getSessionMessages(sessionId);
    const sliced = allTurns.slice(offset, offset + limit);

    if (sliced.length === 0) {
      return { ok: true, message: `Session "${sessionId}" has ${allTurns.length} turns total. Offset ${offset} is past the end.` };
    }

    // Truncate individual turns to keep response size reasonable
    const maxTurnLen = Math.min(2000, Math.floor(12000 / sliced.length));
    const lines = [
      `Session: ${sessionId} | ${session.profile ?? "no-profile"} | ${allTurns.length} turns total`,
      `Showing turns ${offset + 1}–${offset + sliced.length} of ${allTurns.length}\n`,
    ];

    for (const turn of sliced) {
      lines.push(formatTurn(turn, maxTurnLen));
      lines.push(""); // blank line between turns
    }

    return { ok: true, message: lines.join("\n") };
  },

  info: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const sessionId = typeof data.sessionId === "string" ? data.sessionId.trim() : "";
    if (!sessionId) return { ok: false, error: "sessionId is required" };

    const s = ctx.db.getSession(sessionId);
    if (!s) return { ok: false, error: `Session "${sessionId}" not found` };

    const tags = parseTags(s.tags);
    const created = new Date(s.created_at).toISOString();
    const updated = new Date(s.updated_at).toISOString();
    const lastMsg = s.last_message_at ? new Date(s.last_message_at).toISOString() : "n/a";

    const lines = [
      `**${s.id}**`,
      `Profile: ${s.profile ?? "none"}`,
      `Provider: ${s.provider ?? "unknown"}`,
      `Model: ${s.model ?? "unknown"}`,
      `Status: ${s.status}`,
      `Messages: ${s.message_count}`,
      `Cost: $${s.total_cost_usd.toFixed(4)}`,
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
