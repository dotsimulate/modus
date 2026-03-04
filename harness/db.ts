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
    INSERT INTO sessions (id, preview, profile, model, status, created_at, updated_at, last_message_at, message_count, total_cost_usd, last_prompt, last_response, cwd)
    VALUES ($id, $preview, $profile, $model, $status, $now, $now, $now, $message_count, $total_cost_usd, $last_prompt, $last_response, $cwd)
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
  });
}

export function updateSessionStatus(id: string, status: string) {
  stmts.updateStatus.run({ $id: id, $status: status, $now: Date.now() });
}

export function listSessions(limit = 50): SessionRow[] {
  return stmts.list.all({ $limit: limit }) as SessionRow[];
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

export function searchSessions(query: string, limit = 20): SearchHit[] {
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
  const sessions = db.prepare(
    `SELECT * FROM sessions WHERE id IN (${placeholders}) AND archived = 0`
  ).all(...ids) as SessionRow[];
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

// ── Startup Cleanup ──
// Mark orphaned running/starting/error sessions as done (harness restarted while they were active)
db.run(`UPDATE sessions SET status = 'done' WHERE status IN ('running', 'starting', 'error')`);

export { db };
