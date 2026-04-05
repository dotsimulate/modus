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
    session_origin_id TEXT,
    kind        TEXT NOT NULL DEFAULT 'shell',
    owner_type  TEXT,
    owner_name  TEXT,
    provider    TEXT,
    interactive INTEGER NOT NULL DEFAULT 1,
    pid         INTEGER,
    created_at  INTEGER NOT NULL,
    last_output_at INTEGER,
    exited_at   INTEGER,
    exit_code   INTEGER
  )
`);

// Forward-only lightweight migrations for existing dev databases.
try { tdb.run(`ALTER TABLE terminals ADD COLUMN session_origin_id TEXT`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN kind TEXT NOT NULL DEFAULT 'shell'`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN owner_type TEXT`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN owner_name TEXT`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN provider TEXT`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN interactive INTEGER NOT NULL DEFAULT 1`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN pid INTEGER`); } catch {}
try { tdb.run(`ALTER TABLE terminals ADD COLUMN last_output_at INTEGER`); } catch {}

// ── Queries ──

const _insert = tdb.prepare(`
  INSERT INTO terminals (
    id, shell, cwd, cols, rows, status, session_id, session_origin_id,
    kind, owner_type, owner_name, provider, interactive, pid, created_at, last_output_at
  )
  VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const _updateStatus = tdb.prepare(`
  UPDATE terminals SET status = ?, exited_at = ?, exit_code = ? WHERE id = ?
`);

const _get = tdb.prepare(`SELECT * FROM terminals WHERE id = ?`);
const _list = tdb.prepare(`SELECT * FROM terminals ORDER BY created_at DESC`);
const _listActive = tdb.prepare(`SELECT * FROM terminals WHERE status = 'running' ORDER BY created_at DESC`);
const _delete = tdb.prepare(`DELETE FROM terminals WHERE id = ?`);
const _updateSessionId = tdb.prepare(`UPDATE terminals SET session_id = ? WHERE id = ?`);
const _rekeySession = tdb.prepare(`UPDATE terminals SET session_id = ? WHERE session_id = ?`);
const _touchOutput = tdb.prepare(`UPDATE terminals SET last_output_at = ? WHERE id = ?`);

// ── Types ──

export type TerminalRow = {
  id: string;
  shell: string;
  cwd: string | null;
  cols: number;
  rows: number;
  status: string;
  session_id: string | null;
  session_origin_id: string | null;
  kind: string;
  owner_type: string | null;
  owner_name: string | null;
  provider: string | null;
  interactive: number;
  pid: number | null;
  created_at: number;
  last_output_at: number | null;
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
  meta?: {
    sessionOriginId?: string | null;
    kind?: string;
    ownerType?: string | null;
    ownerName?: string | null;
    provider?: string | null;
    interactive?: boolean;
    pid?: number | null;
  },
): void {
  const now = Date.now();
  _insert.run(
    id,
    shell,
    cwd,
    cols,
    rows,
    sessionId,
    meta?.sessionOriginId ?? sessionId,
    meta?.kind ?? "shell",
    meta?.ownerType ?? null,
    meta?.ownerName ?? null,
    meta?.provider ?? null,
    meta?.interactive === false ? 0 : 1,
    meta?.pid ?? null,
    now,
    now,
  );
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

export function updateTerminalSessionId(id: string, sessionId: string): void {
  _updateSessionId.run(sessionId, id);
}

export function rekeyTerminalSessionIds(oldSessionId: string, newSessionId: string): number {
  const result = _rekeySession.run(newSessionId, oldSessionId) as { changes?: number };
  return result.changes ?? 0;
}

export function touchTerminalOutput(id: string, at = Date.now()): void {
  _touchOutput.run(at, id);
}
