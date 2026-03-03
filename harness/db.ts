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

// ── Types ──

export type SessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
};

export type MessageRow = {
  id: number;
  session_id: string;
  role: string;
  content: string;
  thinking: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  model: string | null;
  turns: number | null;
  created_at: number;
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
    INSERT INTO sessions (id, preview, profile, model, status, created_at, updated_at, message_count, total_cost_usd, last_prompt, last_response)
    VALUES ($id, $preview, $profile, $model, $status, $now, $now, $message_count, $total_cost_usd, $last_prompt, $last_response)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = $now,
      status = $status,
      message_count = $message_count,
      total_cost_usd = sessions.total_cost_usd + $total_cost_usd,
      last_prompt = COALESCE($last_prompt, sessions.last_prompt),
      last_response = COALESCE($last_response, sessions.last_response),
      model = COALESCE($model, sessions.model)
  `),
  updateStatus: db.prepare(`UPDATE sessions SET status = $status, updated_at = $now WHERE id = $id`),
  list: db.prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT $limit`),
  get: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
  getActive: db.prepare(`SELECT * FROM sessions WHERE status IN ('running', 'idle', 'starting') ORDER BY updated_at DESC`),
  delete: db.prepare(`DELETE FROM sessions WHERE id = $id`),

  // Messages
  addMessage: db.prepare(`
    INSERT INTO messages (session_id, role, content, thinking, cost_usd, duration_ms, model, turns, created_at)
    VALUES ($session_id, $role, $content, $thinking, $cost_usd, $duration_ms, $model, $turns, $created_at)
  `),
  getMessages: db.prepare(`SELECT * FROM messages WHERE session_id = $session_id ORDER BY created_at ASC`),

  // Events
  addEvent: db.prepare(`
    INSERT INTO events (session_id, seq, type, subtype, data, created_at)
    VALUES ($session_id, $seq, $type, $subtype, $data, $created_at)
  `),
  getEvents: db.prepare(`SELECT * FROM events WHERE session_id = $session_id AND seq > $after_seq ORDER BY seq ASC`),
  getEventCount: db.prepare(`SELECT COUNT(*) as count FROM events WHERE session_id = $session_id`),
  getMaxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) as max_seq FROM events WHERE session_id = $session_id`),
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

export function getActiveSessions(): SessionRow[] {
  return stmts.getActive.all() as SessionRow[];
}

export function deleteSession(id: string) {
  stmts.delete.run({ $id: id });
}

// ── Message Functions ──

export function addMessage(opts: {
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  turns?: number;
}) {
  stmts.addMessage.run({
    $session_id: opts.sessionId,
    $role: opts.role,
    $content: opts.content,
    $thinking: opts.thinking ?? null,
    $cost_usd: opts.costUsd ?? null,
    $duration_ms: opts.durationMs ?? null,
    $model: opts.model ?? null,
    $turns: opts.turns ?? null,
    $created_at: Date.now(),
  });
}

export function getMessages(sessionId: string): MessageRow[] {
  return stmts.getMessages.all({ $session_id: sessionId }) as MessageRow[];
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
}

export function getEvents(sessionId: string, afterSeq = 0): EventRow[] {
  return stmts.getEvents.all({ $session_id: sessionId, $after_seq: afterSeq }) as EventRow[];
}

export function getEventCount(sessionId: string): number {
  const row = stmts.getEventCount.get({ $session_id: sessionId }) as { count: number };
  return row?.count ?? 0;
}

export function getMaxSeq(sessionId: string): number {
  const row = stmts.getMaxSeq.get({ $session_id: sessionId }) as { max_seq: number };
  return row?.max_seq ?? 0;
}

export { db };
