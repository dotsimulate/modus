/**
 * The session search query, taking its connection as a parameter so the
 * backend's own connection and the transcript-read worker's read-only one run
 * exactly the same SQL. Keep this free of side-effecting imports: the worker
 * loads it, and db.ts opens the live database as a side effect of import.
 */
import type { Database } from "bun:sqlite";
import type { SearchHit, SessionRow } from "./db";
import { buildProjectCwdScope } from "./project-cwd-scope";
import { normalizeSearchLimit, normalizeSearchOffset, normalizeSearchSort, parseSessionSearch, type SearchOptions } from "./session-search";

export type SessionSearchScope = {
  cwdPrefixes?: string[];
  agentProfiles?: string[];
  userProfileName?: string;
  role?: string;
  /** Inclusive lower bound on the session's `last_message_at` (epoch ms). */
  lastMessageAfter?: number;
  /** Exclusive upper bound on the session's `last_message_at` (epoch ms). */
  lastMessageBefore?: number;
};

export type SessionSearchOptions = Pick<SearchOptions, "sort" | "offset">;

export function querySessionSearch(
  db: Database,
  query: string,
  limit = 20,
  scope?: SessionSearchScope,
  options?: SessionSearchOptions,
): SearchHit[] {
  const terms = parseSessionSearch(query);
  if (!terms.length) return [];
  const termQueries = terms.map(({ fts }) => scope?.role && ["user", "assistant"].includes(scope.role)
    ? `role:"${scope.role}" AND {content title}: (${fts})`
    : `{content title}: (${fts})`);
  const ftsQuery = termQueries.map(term => `(${term})`).join(" OR ");

  const matchConditions = [
    `search_index_v2 MATCH ?`,
    `s.tags NOT LIKE '%"archived"%'`,
    `s.tags NOT LIKE '%"internal"%'`,
  ];
  const matchParams: (string | number)[] = [];

  if (scope?.userProfileName) {
    matchConditions.push(`(s.user_profile = ? OR s.user_profile IS NULL)`);
    matchParams.push(scope.userProfileName);
  }

  if (scope?.cwdPrefixes && scope.cwdPrefixes.length > 0) {
    const cwdScope = buildProjectCwdScope("s.cwd", scope.cwdPrefixes);
    matchConditions.push(`(${cwdScope.sql})`);
    matchParams.push(...cwdScope.params);
  }

  if (scope?.agentProfiles && scope.agentProfiles.length > 0) {
    const placeholders = scope.agentProfiles.map(() => "?").join(", ");
    matchConditions.push(`s.profile IN (${placeholders})`);
    matchParams.push(...scope.agentProfiles);
  }

  if (scope?.lastMessageAfter !== undefined) {
    matchConditions.push(`s.last_message_at >= ?`);
    matchParams.push(scope.lastMessageAfter);
  }
  if (scope?.lastMessageBefore !== undefined) {
    matchConditions.push(`s.last_message_at < ?`);
    matchParams.push(scope.lastMessageBefore);
  }

  // Recency-blended ranking: FTS5 rank (bm25 with title weight 10x) is blended
  // with a recency bonus so recent sessions float up when relevance is similar.
  // rank is negative (lower = better), recency term is 0..2 (higher = more recent).
  const now = Date.now();
  // Each term may occur in a different message or title within the session.
  const termSelects = termQueries.map((_, index) => `
    SELECT search_index_v2.session_id AS sid, MIN(rank) AS best_rank,
      s.last_message_at AS lma, ${index} AS term
    FROM search_index_v2
    JOIN sessions s ON s.id = search_index_v2.session_id
    WHERE ${matchConditions.join(" AND ")}
    GROUP BY search_index_v2.session_id
  `);
  const sort = normalizeSearchSort(options?.sort);
  const order = sort === "latest" ? "lma DESC, sid ASC"
    : sort === "oldest" ? "lma ASC, sid ASC" : "blended ASC, lma DESC, sid ASC";
  const matches = db.prepare(`
    SELECT sid, best_rank, lma,
      (best_rank - 2.0 * (CAST(lma AS REAL) / ${now})) AS blended
    FROM (
      SELECT
        sid, MIN(best_rank) AS best_rank, MAX(lma) AS lma
      FROM (${termSelects.join(" UNION ALL ")})
      GROUP BY sid
      HAVING COUNT(DISTINCT term) = ${terms.length}
    )
    ORDER BY ${order}
    LIMIT ? OFFSET ?
  `).all(...termQueries.flatMap(term => [term, ...matchParams]), normalizeSearchLimit(limit), normalizeSearchOffset(options?.offset)) as { sid: string; best_rank: number; lma: number }[];

  if (matches.length === 0) return [];

  const ids = matches.map(m => m.sid);
  const placeholders = ids.map(() => "?").join(",");
  const sessions = db.prepare(
    `SELECT * FROM sessions WHERE id IN (${placeholders}) AND tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%'`
  ).all(...ids) as SessionRow[];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  // Build snippets: prefer title matches, then content matches with context
  const snippetStmt = db.prepare(
    `SELECT role, content, title FROM search_index_v2 WHERE session_id = $sid AND search_index_v2 MATCH $fts ORDER BY rank LIMIT 1`
  );

  return matches.flatMap(m => {
    const s = sessionMap.get(m.sid);
    if (!s) return [];

    let snippet = s.last_prompt ?? s.preview;
    try {
      const row = snippetStmt.get({ $sid: m.sid, $fts: ftsQuery }) as { role: string; content: string; title: string } | null;
      if (row) {
        // If the best match is from the title column, use it directly
        const source = row.role === "title" ? row.title : row.content;
        if (source) {
          const lower = source.toLowerCase();
          const positions = terms.map(term => lower.indexOf(term.text.toLowerCase())).filter(index => index >= 0);
          const idx = positions.length ? Math.min(...positions) : -1;
          if (idx >= 0) {
            const start = Math.max(0, idx - 60);
            const raw = source.slice(start, start + 160);
            snippet = (start > 0 ? "..." : "") + raw + (start + 160 < source.length ? "..." : "");
          } else {
            snippet = source.slice(0, 160) + (source.length > 160 ? "..." : "");
          }
        }
      }
    } catch { /* fallback to default snippet */ }

    return [{
      session_id: s.id,
      preview: s.title || s.preview,
      profile: s.profile,
      model: s.model,
      cwd: s.cwd,
      last_message_at: s.last_message_at,
      total_cost_usd: s.total_cost_usd,
      snippet,
    }];
  });
}
