/**
 * Move DB — persisted execution records for moves.
 *
 * Uses the existing harness.db via the shared db module.
 * Move runs are lightweight rows that track activation, status, and spawned sessions.
 * Reuses the same DB file — no separate database.
 */

import { db } from "./db";
import type { MoveRun } from "./move-types";

// ── Schema Migration ──

db.run(`
  CREATE TABLE IF NOT EXISTS move_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    move_name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'inline',
    status TEXT NOT NULL DEFAULT 'pending',
    summary TEXT,
    inputs TEXT,
    gathered_context TEXT,
    token TEXT,
    error TEXT,
    spawned_session_id TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_move_runs_name ON move_runs(move_name, created_at DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_move_runs_session ON move_runs(session_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_move_runs_token ON move_runs(token)`);

// ── Prepared Statements ──

const stmts = {
  insert: db.prepare(`
    INSERT INTO move_runs (move_name, session_id, mode, status, inputs, gathered_context, token, created_at)
    VALUES ($move_name, $session_id, $mode, $status, $inputs, $gathered_context, $token, $created_at)
  `),
  update: db.prepare(`
    UPDATE move_runs SET
      status = COALESCE($status, status),
      summary = COALESCE($summary, summary),
      error = COALESCE($error, error),
      spawned_session_id = COALESCE($spawned_session_id, spawned_session_id),
      completed_at = COALESCE($completed_at, completed_at)
    WHERE id = $id
  `),
  getByName: db.prepare(`
    SELECT * FROM move_runs WHERE move_name = $move_name
    ORDER BY created_at DESC LIMIT $limit
  `),
  getBySession: db.prepare(`
    SELECT * FROM move_runs WHERE session_id = $session_id
    ORDER BY created_at DESC LIMIT $limit
  `),
  getByToken: db.prepare(`
    SELECT * FROM move_runs WHERE token = $token LIMIT 1
  `),
  getById: db.prepare(`
    SELECT * FROM move_runs WHERE id = $id
  `),
};

// ── Functions ──

export function insertMoveRun(opts: {
  moveName: string;
  sessionId: string;
  mode: string;
  status: string;
  inputs?: string;
  gatheredContext?: string;
  token?: string;
}): number {
  stmts.insert.run({
    $move_name: opts.moveName,
    $session_id: opts.sessionId,
    $mode: opts.mode,
    $status: opts.status,
    $inputs: opts.inputs ?? null,
    $gathered_context: opts.gatheredContext ?? null,
    $token: opts.token ?? null,
    $created_at: Date.now(),
  });
  return Number((db.query("SELECT last_insert_rowid() as id").get() as any).id);
}

export function updateMoveRun(id: number | null, updates: {
  status?: string;
  summary?: string;
  error?: string;
  spawnedSessionId?: string;
  completedAt?: number;
}) {
  if (id === null) return;
  stmts.update.run({
    $id: id,
    $status: updates.status ?? null,
    $summary: updates.summary ?? null,
    $error: updates.error ?? null,
    $spawned_session_id: updates.spawnedSessionId ?? null,
    $completed_at: updates.completedAt ?? null,
  });
}

function mapRow(r: any): MoveRun {
  return {
    id: r.id,
    moveName: r.move_name,
    sessionId: r.session_id,
    mode: r.mode,
    status: r.status,
    summary: r.summary,
    createdAt: r.created_at,
    completedAt: r.completed_at,
    spawnedSessionId: r.spawned_session_id,
  };
}

export function getMoveRuns(moveName: string, limit = 20): MoveRun[] {
  return (stmts.getByName.all({ $move_name: moveName, $limit: limit }) as any[]).map(mapRow);
}

export function getMoveRunsBySession(sessionId: string, limit = 20): MoveRun[] {
  return (stmts.getBySession.all({ $session_id: sessionId, $limit: limit }) as any[]).map(mapRow);
}

export function getMoveRunByToken(token: string): MoveRun | null {
  const row = stmts.getByToken.get({ $token: token }) as any;
  return row ? mapRow(row) : null;
}

export function getMoveRunById(id: number): MoveRun | null {
  const row = stmts.getById.get({ $id: id }) as any;
  return row ? mapRow(row) : null;
}
