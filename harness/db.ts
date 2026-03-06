import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "harness.db");
const db = new Database(DB_PATH);

// WAL mode for concurrent reads during streaming
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// ── Sessions ──
db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    preview TEXT NOT NULL,
    profile TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    last_prompt TEXT,
    last_response TEXT
  )
`);

// Migration: add status column if missing (existing DBs)
try { db.run(`ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'done'`); } catch { /* already exists */ }
// Migration: add archived column if missing
try { db.run(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
// Migration: add draft_text column for persisting unsent user input
try { db.run(`ALTER TABLE sessions ADD COLUMN draft_text TEXT DEFAULT ''`); } catch { /* already exists */ }
// Migration: add last_message_at — tracks actual conversation activity (not drafts/status changes)
try { db.run(`ALTER TABLE sessions ADD COLUMN last_message_at INTEGER`); } catch { /* already exists */ }
// Backfill: seed last_message_at from updated_at for existing rows
db.run(`UPDATE sessions SET last_message_at = updated_at WHERE last_message_at IS NULL`);
// Migration: add cwd — working directory / project root for grouping
try { db.run(`ALTER TABLE sessions ADD COLUMN cwd TEXT`); } catch { /* already exists */ }
// Migration: rename schedule_name → action_name
try { db.run(`ALTER TABLE sessions ADD COLUMN action_name TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE sessions RENAME COLUMN schedule_name TO action_name`); } catch { /* already renamed or never existed */ }
// Migration: add pruned flag for event pruning (removes redundant streaming deltas)
try { db.run(`ALTER TABLE sessions ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
// Migration: rename compacted → pruned (if upgrading from older schema)
try { db.run(`ALTER TABLE sessions RENAME COLUMN compacted TO pruned`); } catch { /* already renamed or never existed */ }

// ── Messages (high-level conversation history) ──
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    thinking TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    model TEXT,
    turns INTEGER,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);

// ── Events (full SDK event log) ──
db.run(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    subtype TEXT,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events(session_id, seq)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_last_message ON sessions(archived, last_message_at DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd, archived, last_message_at DESC)`);

// ── Action Runs (tracks each execution of an action) ──
db.run(`
  CREATE TABLE IF NOT EXISTS action_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_name TEXT NOT NULL,
    session_id TEXT,
    run_number INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    cycle_number INTEGER NOT NULL DEFAULT 1,
    trigger_type TEXT,
    after_run_error TEXT,
    user_profile TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_action_runs_name ON action_runs(action_name, run_number DESC)`);
// Migration: rename schedule_runs → action_runs (copy data if old table exists)
try {
  const hasOld = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_runs'`).get();
  if (hasOld) {
    db.run(`INSERT OR IGNORE INTO action_runs (id, action_name, session_id, run_number, status, summary, started_at, completed_at, cost_usd, error, cycle_number, user_profile)
            SELECT id, schedule_name, session_id, run_number, status, summary, started_at, completed_at, cost_usd, error, COALESCE(cycle_number, 1), user_profile FROM schedule_runs`);
    db.run(`DROP TABLE schedule_runs`);
    console.log("[db] Migrated schedule_runs → action_runs");
  }
} catch { /* already migrated */ }

// ── Types ──

export type SessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
  cwd: string | null;
  action_name: string | null;
};

export type EventRow = {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  created_at: number;
};

// ── Prepared Statements ──

const stmts = {
  // Sessions
  upsert: db.prepare(`
    INSERT INTO sessions (id, preview, profile, model, status, created_at, updated_at, last_message_at, message_count, total_cost_usd, last_prompt, last_response, cwd, action_name)
    VALUES ($id, $preview, $profile, $model, $status, $now, $now, $now, $message_count, $total_cost_usd, $last_prompt, $last_response, $cwd, $action_name)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = $now,
      last_message_at = $now,
      status = $status,
      message_count = $message_count,
      total_cost_usd = sessions.total_cost_usd + $total_cost_usd,
      last_prompt = COALESCE($last_prompt, sessions.last_prompt),
      last_response = COALESCE($last_response, sessions.last_response),
      model = COALESCE($model, sessions.model)
  `),
  updateStatus: db.prepare(`UPDATE sessions SET status = $status, updated_at = $now WHERE id = $id`),
  list: db.prepare(`SELECT * FROM sessions WHERE archived = 0 ORDER BY last_message_at DESC LIMIT $limit`),
  archive: db.prepare(`UPDATE sessions SET archived = 1, updated_at = $now WHERE id = $id`),
  get: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
  // Events
  addEvent: db.prepare(`
    INSERT INTO events (session_id, seq, type, subtype, data, created_at)
    VALUES ($session_id, $seq, $type, $subtype, $data, $created_at)
  `),
  getEvents: db.prepare(`SELECT * FROM events WHERE session_id = $session_id AND seq > $after_seq ORDER BY seq ASC`),
  getMaxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) as max_seq FROM events WHERE session_id = $session_id`),
  // Drafts
  getDraft: db.prepare(`SELECT draft_text FROM sessions WHERE id = $id`),
  setDraft: db.prepare(`UPDATE sessions SET draft_text = $draft_text WHERE id = $id`),
  // Action Runs
  insertActionRun: db.prepare(`
    INSERT INTO action_runs (action_name, session_id, run_number, status, started_at, cycle_number, trigger_type, user_profile)
    VALUES ($action_name, $session_id, $run_number, $status, $started_at, $cycle_number, $trigger_type, $user_profile)
  `),
  updateActionRun: db.prepare(`
    UPDATE action_runs SET
      status = COALESCE($status, status),
      summary = COALESCE($summary, summary),
      completed_at = COALESCE($completed_at, completed_at),
      cost_usd = COALESCE($cost_usd, cost_usd),
      error = COALESCE($error, error),
      session_id = COALESCE($session_id, session_id),
      after_run_error = COALESCE($after_run_error, after_run_error)
    WHERE id = $id
  `),
  getActionRuns: db.prepare(`
    SELECT id, action_name, session_id, run_number, status, summary, started_at, completed_at, cost_usd, error, cycle_number, trigger_type, after_run_error, user_profile
    FROM action_runs WHERE action_name = $action_name
    ORDER BY run_number DESC LIMIT $limit
  `),
  getRunSummaries: db.prepare(`
    SELECT run_number, summary, completed_at FROM (
      SELECT run_number, summary, completed_at
      FROM action_runs
      WHERE action_name = $action_name AND status = 'done' AND summary IS NOT NULL
      ORDER BY run_number DESC LIMIT $limit
    ) ORDER BY run_number ASC
  `),
  getNextRunNumber: db.prepare(`
    SELECT COALESCE(MAX(run_number), 0) + 1 AS next
    FROM action_runs WHERE action_name = $action_name
  `),
};

// ── Session Functions ──

export function upsertSession(opts: {
  id: string;
  preview: string;
  profile?: string;
  model?: string;
  status?: string;
  messageCount: number;
  costUsd: number;
  lastPrompt?: string;
  lastResponse?: string;
  cwd?: string;
  actionName?: string;
}) {
  stmts.upsert.run({
    $id: opts.id,
    $preview: opts.preview,
    $profile: opts.profile ?? null,
    $model: opts.model ?? null,
    $status: opts.status ?? "done",
    $now: Date.now(),
    $message_count: opts.messageCount,
    $total_cost_usd: opts.costUsd,
    $last_prompt: opts.lastPrompt ?? null,
    $last_response: opts.lastResponse ?? null,
    $cwd: opts.cwd ?? null,
    $action_name: opts.actionName ?? null,
  });
}

export function updateSessionStatus(id: string, status: string) {
  stmts.updateStatus.run({ $id: id, $status: status, $now: Date.now() });
}

export function listSessions(limit = 50): SessionRow[] {
  return stmts.list.all({ $limit: limit }) as SessionRow[];
}

/** List sessions filtered to specific project CWD prefixes */
export function listSessionsForProjects(cwdPrefixes: string[], limit = 50): SessionRow[] {
  if (cwdPrefixes.length === 0) return listSessions(limit);
  const conditions = cwdPrefixes.map(() => "cwd LIKE ?").join(" OR ");
  const sql = `SELECT * FROM sessions WHERE archived = 0 AND (${conditions}) ORDER BY last_message_at DESC LIMIT ?`;
  const params = [...cwdPrefixes.map((p) => p.replace(/%/g, "\\%") + "%"), limit];
  return db.prepare(sql).all(...params) as SessionRow[];
}

export function getSession(id: string): SessionRow | null {
  return (stmts.get.get({ $id: id }) as SessionRow) ?? null;
}

export function archiveSession(id: string) {
  stmts.archive.run({ $id: id, $now: Date.now() });
}

// ── Event Functions ──

export function addEvent(sessionId: string, seq: number, type: string, subtype: string | null, data: string) {
  stmts.addEvent.run({
    $session_id: sessionId,
    $seq: seq,
    $type: type,
    $subtype: subtype,
    $data: data,
    $created_at: Date.now(),
  });
  indexEvent(sessionId, type, data);
}

export function getEvents(sessionId: string, afterSeq = 0): EventRow[] {
  return stmts.getEvents.all({ $session_id: sessionId, $after_seq: afterSeq }) as EventRow[];
}

export function getMaxSeq(sessionId: string): number {
  const row = stmts.getMaxSeq.get({ $session_id: sessionId }) as { max_seq: number };
  return row?.max_seq ?? 0;
}

// ── Draft Functions ──

export function getDraft(sessionId: string): string {
  const row = stmts.getDraft.get({ $id: sessionId }) as { draft_text: string } | null;
  return row?.draft_text ?? "";
}

export function setDraft(sessionId: string, text: string) {
  stmts.setDraft.run({ $id: sessionId, $draft_text: text });
}

// ── Action Run Functions ──

import type { RunSummary, RunMeta } from "./action-types";

export function insertActionRun(actionName: string, runNumber: number, sessionId: string | null, startedAt: number, cycleNumber = 1, triggerType?: string, userProfile?: string): number {
  stmts.insertActionRun.run({
    $action_name: actionName,
    $session_id: sessionId,
    $run_number: runNumber,
    $status: "running",
    $started_at: startedAt,
    $cycle_number: cycleNumber,
    $trigger_type: triggerType ?? null,
    $user_profile: userProfile ?? null,
  });
  return Number((db.query("SELECT last_insert_rowid() as id").get() as any).id);
}

export function updateActionRun(id: number, updates: {
  status?: string;
  summary?: string;
  completedAt?: number;
  costUsd?: number;
  error?: string;
  sessionId?: string;
  afterRunError?: string;
}) {
  stmts.updateActionRun.run({
    $id: id,
    $status: updates.status ?? null,
    $summary: updates.summary ?? null,
    $completed_at: updates.completedAt ?? null,
    $cost_usd: updates.costUsd ?? null,
    $error: updates.error ?? null,
    $session_id: updates.sessionId ?? null,
    $after_run_error: updates.afterRunError ?? null,
  });
}

export function getActionRuns(actionName: string, limit = 20): RunMeta[] {
  const rows = stmts.getActionRuns.all({ $action_name: actionName, $limit: limit }) as any[];
  return rows.map(r => ({
    id: r.id,
    runNumber: r.run_number,
    cycleNumber: r.cycle_number ?? 1,
    sessionId: r.session_id,
    status: r.status,
    summary: r.summary,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    costUsd: r.cost_usd,
    error: r.error,
    triggerType: r.trigger_type ?? "interval",
    afterRunError: r.after_run_error,
  }));
}

export function getRunSummaries(actionName: string, limit = 5): RunSummary[] {
  const rows = stmts.getRunSummaries.all({ $action_name: actionName, $limit: limit }) as any[];
  return rows.map(r => ({
    runNumber: r.run_number,
    summary: r.summary,
    completedAt: r.completed_at,
  }));
}

export function getNextRunNumber(actionName: string): number {
  const row = stmts.getNextRunNumber.get({ $action_name: actionName }) as { next: number };
  return row.next;
}

export function clearActionRuns(actionName: string): void {
  db.prepare(`DELETE FROM action_runs WHERE action_name = $name`).run({ $name: actionName });
}

// ── Full-Text Search (FTS5) ──

db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  session_id UNINDEXED,
  role,
  content,
  tokenize = 'porter unicode61'
)`);

// Populate FTS from existing events (only if empty — avoids duplicates on restart)
const ftsCount = (db.prepare(`SELECT COUNT(*) as n FROM search_index`).get() as any).n;
if (ftsCount === 0) {
  const rebuildStmt = db.prepare(`INSERT INTO search_index (session_id, role, content) VALUES ($sid, $role, $text)`);
  const events = db.prepare(`SELECT session_id, type, data FROM events WHERE type IN ('user', 'result')`).all() as any[];
  db.transaction(() => {
    for (const ev of events) {
      let text: string | null = null;
      if (ev.type === "user") {
        try { text = JSON.parse(ev.data)?.message?.content; } catch { /* skip */ }
      } else if (ev.type === "result") {
        try { text = JSON.parse(ev.data)?.result; } catch { /* skip */ }
      }
      if (typeof text === "string" && text.length > 0) {
        rebuildStmt.run({ $sid: ev.session_id, $role: ev.type, $text: text });
      }
    }
  })();
}

/** Insert into FTS index — call alongside addEvent for user/result events */
export function indexEvent(sessionId: string, type: string, data: string) {
  if (type !== "user" && type !== "result") return;
  let text: string | null = null;
  try {
    const parsed = JSON.parse(data);
    text = type === "user" ? parsed?.message?.content : parsed?.result;
  } catch { return; }
  if (typeof text === "string" && text.length > 0) {
    db.prepare(`INSERT INTO search_index (session_id, role, content) VALUES ($sid, $role, $text)`)
      .run({ $sid: sessionId, $role: type, $text: text });
  }
}

export type SearchHit = {
  session_id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  cwd: string | null;
  last_message_at: number;
  total_cost_usd: number;
  snippet: string;
};

export function searchSessions(query: string, limit = 20, cwdPrefixes?: string[]): SearchHit[] {
  const ftsQuery = query.trim().split(/\s+/).map(t => `"${t}"*`).join(" ");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  // Find matching session IDs ranked by relevance
  const matches = db.prepare(`
    SELECT session_id AS sid, MIN(rank) AS best_rank
    FROM search_index
    WHERE search_index MATCH $fts
    GROUP BY session_id
    ORDER BY best_rank
    LIMIT $limit
  `).all({ $fts: ftsQuery, $limit: limit }) as { sid: string; best_rank: number }[];

  if (matches.length === 0) return [];

  const ids = matches.map(m => m.sid);
  const placeholders = ids.map(() => "?").join(",");
  let sessionsQuery = `SELECT * FROM sessions WHERE id IN (${placeholders}) AND archived = 0`;
  const params: any[] = [...ids];
  if (cwdPrefixes && cwdPrefixes.length > 0) {
    const cwdConds = cwdPrefixes.map(() => "cwd LIKE ?").join(" OR ");
    sessionsQuery += ` AND (${cwdConds})`;
    params.push(...cwdPrefixes.map((p) => p.replace(/%/g, "\\%") + "%"));
  }
  const sessions = db.prepare(sessionsQuery).all(...params) as SessionRow[];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  // Build snippets from the actual indexed content
  const snippetStmt = db.prepare(
    `SELECT content FROM search_index WHERE session_id = $sid AND content LIKE $pattern LIMIT 1`
  );

  return matches.flatMap(m => {
    const s = sessionMap.get(m.sid);
    if (!s) return [];
    const pattern = `%${terms[0]}%`;
    const row = snippetStmt.get({ $sid: m.sid, $pattern: pattern }) as { content: string } | null;
    let snippet = s.last_prompt ?? s.preview;
    if (row?.content) {
      const lower = row.content.toLowerCase();
      const idx = lower.indexOf(terms[0] ?? "");
      const start = Math.max(0, idx - 60);
      const raw = row.content.slice(start, start + 160);
      snippet = (start > 0 ? "..." : "") + raw + (start + 160 < row.content.length ? "..." : "");
    }
    return [{
      session_id: s.id,
      preview: s.preview,
      profile: s.profile,
      model: s.model,
      cwd: s.cwd,
      last_message_at: s.last_message_at,
      total_cost_usd: s.total_cost_usd,
      snippet,
    }];
  });
}

// ── Event Compaction ──
// After a session goes idle, prune redundant streaming deltas to save space.
// Keeps assistant/user/system/result events intact — only removes text_delta and thinking_delta.

const pruneDeleteStmt = db.prepare(`
  DELETE FROM events
  WHERE session_id = $sid
    AND type = 'stream_event'
    AND subtype IN ('text_delta', 'thinking_delta', 'content_block_start', 'content_block_stop', 'content_block_delta', 'message_start', 'message_delta', 'message_stop', 'input_json_delta')
`);

const markPrunedStmt = db.prepare(`UPDATE sessions SET pruned = 1 WHERE id = $sid`);

/** Prune a single session — delete redundant streaming deltas, keep assembled events */
export function pruneSessionEvents(sessionId: string): { deleted: number } {
  const result = pruneDeleteStmt.run({ $sid: sessionId });
  markPrunedStmt.run({ $sid: sessionId });
  return { deleted: result.changes };
}

/** Prune all idle/done sessions that haven't been pruned yet */
export function pruneAllSessionEvents(): { sessions: number; events: number } {
  const unpruned = db.prepare(
    `SELECT id FROM sessions WHERE pruned = 0 AND status IN ('idle', 'done') AND archived = 0`
  ).all() as { id: string }[];
  let totalDeleted = 0;
  db.transaction(() => {
    for (const { id } of unpruned) {
      const { deleted } = pruneSessionEvents(id);
      totalDeleted += deleted;
    }
  })();
  return { sessions: unpruned.length, events: totalDeleted };
}

/** Storage stats per project */
export function storageStats(): { project: string; sessions: number; events: number; bytes: number }[] {
  return db.prepare(`
    SELECT COALESCE(s.cwd, '(unscoped)') as project,
           COUNT(DISTINCT s.id) as sessions,
           COUNT(e.id) as events,
           COALESCE(SUM(LENGTH(e.data)), 0) as bytes
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    WHERE s.archived = 0
    GROUP BY s.cwd
    ORDER BY bytes DESC
  `).all() as any[];
}

// ── Startup Cleanup ──
// Mark orphaned running/starting/idle/error sessions as done (harness restarted while they were active)
db.run(`UPDATE sessions SET status = 'done' WHERE status IN ('running', 'starting', 'idle', 'error')`);

export { db };
