/**
 * Terminal DB — separate SQLite database for terminal metadata.
 *
 * Separate from harness.db because:
 *   - Different lifecycle: terminals are ephemeral, sessions are archival
 *   - No output storage: PTY output streams live, not persisted here
 *   - Independent rotation/cleanup without touching session data
 */

import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "terminal.db");
const tdb = new Database(DB_PATH);

tdb.run("PRAGMA journal_mode = WAL");

tdb.run(`
  CREATE TABLE IF NOT EXISTS terminals (
    id          TEXT PRIMARY KEY,
    shell       TEXT NOT NULL DEFAULT '/bin/bash',
    cwd         TEXT,
    cols        INTEGER NOT NULL DEFAULT 80,
    rows        INTEGER NOT NULL DEFAULT 24,
    status      TEXT NOT NULL DEFAULT 'running',
    session_id  TEXT,
    created_at  INTEGER NOT NULL,
    exited_at   INTEGER,
    exit_code   INTEGER
  )
`);

// ── Queries ──

const _insert = tdb.prepare(`
  INSERT INTO terminals (id, shell, cwd, cols, rows, status, session_id, created_at)
  VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
`);

const _updateStatus = tdb.prepare(`
  UPDATE terminals SET status = ?, exited_at = ?, exit_code = ? WHERE id = ?
`);

const _get = tdb.prepare(`SELECT * FROM terminals WHERE id = ?`);
const _list = tdb.prepare(`SELECT * FROM terminals ORDER BY created_at DESC`);
const _listActive = tdb.prepare(`SELECT * FROM terminals WHERE status = 'running' ORDER BY created_at DESC`);
const _delete = tdb.prepare(`DELETE FROM terminals WHERE id = ?`);

// ── Types ──

export type TerminalRow = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  status: string;
  session_id: string | null;
  created_at: number;
  exited_at: number | null;
  exit_code: number | null;
};

// ── Exports ──

export function insertTerminal(
  id: string,
  shell: string,
  cwd: string | null,
  cols: number,
  rows: number,
  sessionId: string | null,
): void {
  _insert.run(id, shell, cwd, cols, rows, sessionId, Date.now());
}

export function markTerminalExited(id: string, exitCode: number | null): void {
  _updateStatus.run("exited", Date.now(), exitCode, id);
}

export function getTerminal(id: string): TerminalRow | null {
  return _get.get(id) as TerminalRow | null;
}

export function listTerminals(): TerminalRow[] {
  return _list.all() as TerminalRow[];
}

export function listActiveTerminals(): TerminalRow[] {
  return _listActive.all() as TerminalRow[];
}

export function deleteTerminalRow(id: string): void {
  _delete.run(id);
}
