import { Database } from "bun:sqlite";
import { basename, isAbsolute, normalize, resolve } from "path";
import { resolveDatabasePath } from "./database-paths";
import {
  estimateTurnDetailBytes,
  reconstructSessionTurns,
  summarizeContentBlocks,
  type SessionHistoryEventRow,
} from "./session-history";
import { hasTurnStats, turnMetaFromResultEvent, type TurnMeta } from "./turn-meta";
import { buildProjectCwdScope } from "./project-cwd-scope";

const DB_PATH = resolveDatabasePath("harness.db");
const db = new Database(DB_PATH);

// WAL mode for concurrent reads during streaming
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");

// Disable auto-checkpoint — we'll do passive checkpoints on a timer instead
// to avoid blocking the main thread during writes
db.run("PRAGMA wal_autocheckpoint = 0");

// Periodic passive WAL checkpoint (non-blocking)
setInterval(() => {
  const t0 = performance.now();
  const result = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as any;
  const ms = performance.now() - t0;
  console.log(`[WAL] passive checkpoint ${ms.toFixed(1)}ms busy=${result.busy} checkpointed=${result.checkpointed}/${result.log} pages`);
}, 30_000);

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
try { db.run(`UPDATE sessions SET last_message_at = updated_at WHERE last_message_at IS NULL`); } catch { /* db locked or readonly — will backfill on next clean start */ }
// Migration: add cwd — working directory / project root for grouping
try { db.run(`ALTER TABLE sessions ADD COLUMN cwd TEXT`); } catch { /* already exists */ }
// Migration: rename schedule_name → action_name
try { db.run(`ALTER TABLE sessions ADD COLUMN action_name TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE sessions RENAME COLUMN schedule_name TO action_name`); } catch { /* already renamed or never existed */ }
// Migration: add pruned flag for event pruning (removes redundant streaming deltas)
try { db.run(`ALTER TABLE sessions ADD COLUMN pruned INTEGER NOT NULL DEFAULT 0`); } catch { /* already exists */ }
// Migration: add user_profile — which user profile spawned this session
try { db.run(`ALTER TABLE sessions ADD COLUMN user_profile TEXT`); } catch { /* already exists */ }
// Migration: rename compacted → pruned (if upgrading from older schema)
try { db.run(`ALTER TABLE sessions RENAME COLUMN compacted TO pruned`); } catch { /* already renamed or never existed */ }
// Migration: add fork metadata for branched sessions (consumed on first resume)
try { db.run(`ALTER TABLE sessions ADD COLUMN parent_session_id TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE sessions ADD COLUMN branch_message_uuid TEXT`); } catch { /* already exists */ }
// Migration: add title — user-set or auto-generated session label
try { db.run(`ALTER TABLE sessions ADD COLUMN title TEXT`); } catch { /* already exists */ }
// Migration: add tags — JSON array of string tags (replaces archived column)
try { db.run(`ALTER TABLE sessions ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`); } catch { /* already exists */ }
// Backfill: seed tags from archived column for existing rows
try { db.run(`UPDATE sessions SET tags = '["archived"]' WHERE archived = 1 AND tags = '[]'`); } catch { /* db locked or readonly */ }
// Migration: add provider — resolved execution backend for sidebar/display
try { db.run(`ALTER TABLE sessions ADD COLUMN provider TEXT`); } catch { /* already exists */ }
// Provider-native conversation/thread identity. This is deliberately separate
// from the stable Modus row ID: providers are free to return a different ID.
try { db.run(`ALTER TABLE sessions ADD COLUMN provider_session_id TEXT`); } catch { /* already exists */ }
// Migration: add ui_state — per-session UI layout persistence (panel widths, open state, etc.)
try { db.run(`ALTER TABLE sessions ADD COLUMN ui_state TEXT DEFAULT '{}'`); } catch { /* already exists */ }
// Migration: add archived_at — timestamp when session was archived (for recent-archive browsing)
try { db.run(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`); } catch { /* already exists */ }
// Backfill: seed archived_at from updated_at for already-archived sessions
try { db.run(`UPDATE sessions SET archived_at = updated_at WHERE archived = 1 AND archived_at IS NULL`); } catch { /* db locked or readonly */ }

// ── Web Positions (spatial layout for session web view) ──
db.run(`
  CREATE TABLE IF NOT EXISTS web_positions (
    node_id   TEXT NOT NULL,
    scope     TEXT NOT NULL,
    x         REAL NOT NULL,
    y         REAL NOT NULL,
    pinned    INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    PRIMARY KEY (node_id, scope)
  )
`);

// ── Messages (high-level conversation history) ──
db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    uuid TEXT,
    thinking TEXT,
    tool_calls_json TEXT,
    cost_usd REAL,
    duration_ms INTEGER,
    model TEXT,
    turns INTEGER,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
try { db.run(`ALTER TABLE messages ADD COLUMN seq INTEGER`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE messages ADD COLUMN uuid TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE messages ADD COLUMN tool_calls_json TEXT`); } catch { /* already exists */ }
db.run(`CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq, created_at)`);

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

// ── Session Artifacts (media/files attached to a specific session turn) ──
db.run(`
  CREATE TABLE IF NOT EXISTS session_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    target_message_uuid TEXT,
    action_name TEXT,
    action_run_id INTEGER REFERENCES action_runs(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    path TEXT NOT NULL,
    preview_text TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_session_artifacts_session_seq ON session_artifacts(session_id, seq, created_at)`);
try { db.run(`ALTER TABLE session_artifacts ADD COLUMN target_message_uuid TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE session_artifacts ADD COLUMN preview_text TEXT`); } catch { /* already exists */ }
try { db.run(`ALTER TABLE session_artifacts ADD COLUMN metadata_json TEXT`); } catch { /* already exists */ }
db.run(`CREATE INDEX IF NOT EXISTS idx_session_artifacts_target_uuid ON session_artifacts(session_id, target_message_uuid, created_at)`);

// ── Checkpoints (shadow-repo working-tree snapshots per user prompt) ──
db.run(`
  CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    commit_hash TEXT NOT NULL,
    cwd TEXT NOT NULL,
    manifest_json TEXT,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoints_session_seq ON checkpoints(session_id, seq)`);
try { db.run(`ALTER TABLE checkpoints ADD COLUMN manifest_json TEXT`); } catch { /* already exists */ }

// Provider tool-call observations are provenance only. They are never used as
// authority for workspace undo because a provider can edit through shells or
// external processes that do not emit a precise file tool call.
db.run(`
  CREATE TABLE IF NOT EXISTS file_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    provider TEXT,
    tool_call_id TEXT,
    tool_name TEXT NOT NULL,
    path TEXT NOT NULL,
    operation TEXT NOT NULL,
    evidence TEXT NOT NULL,
    details_json TEXT,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_file_observations_session_seq ON file_observations(session_id, seq, id)`);

// ── Action Executions (lifecycle instances — one complete pass through run budget) ──
db.run(`
  CREATE TABLE IF NOT EXISTS action_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    run_count INTEGER DEFAULT 0,
    cycle_count INTEGER DEFAULT 1,
    total_cost_usd REAL DEFAULT 0,
    config_snapshot TEXT
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_executions_action ON action_executions(action_name)`);
try { db.run(`ALTER TABLE action_executions ADD COLUMN action_scope TEXT`); } catch { /* already exists */ }
db.run(`CREATE INDEX IF NOT EXISTS idx_executions_scope ON action_executions(action_scope)`);

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
try { db.run(`ALTER TABLE action_runs ADD COLUMN action_scope TEXT`); } catch { /* already exists */ }
db.run(`CREATE INDEX IF NOT EXISTS idx_action_runs_scope ON action_runs(action_scope, run_number DESC)`);
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

// Migration: add attempts + verify_error columns
try {
  db.run(`ALTER TABLE action_runs ADD COLUMN attempts INTEGER DEFAULT 1`);
} catch { /* column already exists */ }
try {
  db.run(`ALTER TABLE action_runs ADD COLUMN verify_error TEXT`);
} catch { /* column already exists */ }
try {
  db.run(`ALTER TABLE action_runs ADD COLUMN warning TEXT`);
} catch { /* column already exists */ }
// Migration: add execution_id column linking runs to executions
try {
  db.run(`ALTER TABLE action_runs ADD COLUMN execution_id INTEGER REFERENCES action_executions(id)`);
} catch { /* column already exists */ }

// ── Scheduled Wakes (ctx.sessions.wake with at/every/onEvent) ──
// One-shot {at} and recurring {every} fire from the wake-scheduler tick loop;
// {onEvent} wakes match against session lifecycle events. Persisted so agent-
// registered wakes survive restart.
db.run(`
  CREATE TABLE IF NOT EXISTS scheduled_wakes (
    id           TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    content      TEXT NOT NULL,
    kind         TEXT NOT NULL,            -- 'at' | 'every' | 'onEvent'
    fire_at      INTEGER,                  -- next fire time (ms) for at/every
    every_ms     INTEGER,                  -- interval for recurring
    on_event     TEXT,                     -- JSON SessionTriggerEvent for onEvent
    origin_kind  TEXT,                     -- HarnessSelf.kind that scheduled it
    origin_name  TEXT,                     -- HarnessSelf.name
    cwd          TEXT,
    user_profile TEXT,
    created_at   INTEGER NOT NULL,
    last_fired_at INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_scheduled_wakes_fire ON scheduled_wakes(fire_at)`);

function parseTempSessionCreatedAt(sessionId: string): number | null {
  if (!sessionId.startsWith("ses-")) return null;
  const rest = sessionId.slice(4);
  const dash = rest.indexOf("-");
  if (dash === -1) return null;
  const createdAt = Number(rest.slice(0, dash));
  return Number.isFinite(createdAt) ? createdAt : null;
}

function repairActionRunSessionLinks() {
  const brokenRuns = db.prepare(`
    SELECT id, action_name, session_id
    FROM action_runs
    WHERE session_id LIKE 'ses-%'
  `).all() as Array<{ id: number; action_name: string; session_id: string }>;
  if (brokenRuns.length === 0) return;

  const findSession = db.prepare(`
    SELECT id
    FROM sessions
    WHERE action_name = $action_name
      AND created_at BETWEEN $created_at_min AND $created_at_max
    ORDER BY ABS(created_at - $created_at), id
    LIMIT 1
  `);
  const updateRun = db.prepare(`
    UPDATE action_runs SET session_id = $session_id WHERE id = $id
  `);

  let repaired = 0;
  for (const run of brokenRuns) {
    const createdAt = parseTempSessionCreatedAt(run.session_id);
    if (!createdAt) continue;
    const session = findSession.get({
      $action_name: run.action_name,
      $created_at: createdAt,
      $created_at_min: createdAt - 1000,
      $created_at_max: createdAt + 1000,
    }) as { id: string } | null;
    if (!session || session.id === run.session_id) continue;
    updateRun.run({ $id: run.id, $session_id: session.id });
    repaired++;
  }

  if (repaired > 0) {
    console.log(`[db] Repaired ${repaired} action run session link(s) after temp session rekey`);
  }
}

repairActionRunSessionLinks();

// ── Types ──

export type SessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  user_profile: string | null;
  provider: string | null;
  provider_session_id: string | null;
  model: string | null;
  status: string;
  archived: number;
  created_at: number;
  updated_at: number;
  last_message_at: number;
  message_count: number;
  total_cost_usd: number;
  last_prompt: string | null;
  last_response: string | null;
  cwd: string | null;
  action_name: string | null;
  parent_session_id: string | null;
  branch_message_uuid: string | null;
  title: string | null;
  tags: string; // JSON array of strings, e.g. '["archived"]'
  archived_at: number | null;
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

export type SessionUsageRow = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type StoredSessionConfig = {
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  toolStates?: Record<string, string>;
  providerControls?: Record<string, unknown>;
  cwd?: string;
  additionalDirectories?: string[];
  loadProjectSettings?: boolean;
};

// ── Message Content Types ──

export type TurnToolCall = {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  status?: "completed" | "error";
};

export type TurnContentBlock =
  | { type: "text"; text?: string; textStart?: number; textEnd?: number }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call"; toolCall: TurnToolCall }
  | {
      type: "deferred";
      hasThinking: boolean;
      toolCallCount: number;
      /** Tool name → count, so a deferred run renders the same header as a loaded one. */
      toolNames: Record<string, number>;
    };

export type TurnContent = {
  /** `system` carries harness-authored notices — currently provider failures —
   * which are neither the user's words nor the model's. */
  role: "user" | "assistant" | "system";
  seq: number;
  text: string;
  thinking?: string;
  toolCalls?: TurnToolCall[];
  /** Provider content blocks in their original chronological order. */
  contentBlocks?: TurnContentBlock[];
  uuid?: string;
  artifacts?: SessionArtifactValue[];
  /**
   * Usage for the turn, reconstructed from its `result` event. Assistant turns
   * only, and absent when the turn never completed.
   */
  meta?: TurnMeta;
  /** Heavy thinking/tool payload was intentionally omitted from a summary page. */
  detailsDeferred?: boolean;
  deferredToolCallCount?: number;
  /** Whether the omitted payload included thinking. Sent, never inferred. */
  deferredHasThinking?: boolean;
  timestamp: number;
};

type MessageRow = {
  id: number;
  session_id: string;
  seq: number | null;
  role: string;
  content: string;
  uuid: string | null;
  thinking: string | null;
  tool_calls_json: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  model: string | null;
  turns: number | null;
  created_at: number;
};

export type SessionArtifactRow = {
  id: number;
  session_id: string;
  seq: number;
  target_message_uuid: string | null;
  action_name: string | null;
  action_run_id: number | null;
  name: string;
  mime: string;
  path: string;
  preview_text: string | null;
  metadata_json: string | null;
  created_at: number;
};

export type SessionArtifactValue = {
  id: number;
  sessionId: string;
  seq: number;
  targetMessageUuid?: string;
  name: string;
  mime: string;
  url: string;
  sourceAction?: string;
  createdAt: number;
  previewText?: string;
  metadata?: Record<string, unknown>;
};

// ── Prepared Statements ──

const stmts = {
  // Sessions
  upsert: db.prepare(`
    INSERT INTO sessions (id, preview, profile, provider, provider_session_id, model, status, created_at, updated_at, last_message_at, message_count, total_cost_usd, last_prompt, last_response, cwd, action_name, user_profile, parent_session_id, branch_message_uuid, title)
    VALUES ($id, $preview, $profile, $provider, $provider_session_id, $model, $status, $now, $now, $now, $message_count, $total_cost_usd, $last_prompt, $last_response, $cwd, $action_name, $user_profile, $parent_session_id, $branch_message_uuid, $title)
    ON CONFLICT(id) DO UPDATE SET
      updated_at = $now,
      last_message_at = $now,
      status = $status,
      message_count = $message_count,
      total_cost_usd = $total_cost_usd,
      last_prompt = COALESCE($last_prompt, sessions.last_prompt),
      last_response = COALESCE($last_response, sessions.last_response),
      provider = COALESCE($provider, sessions.provider),
      provider_session_id = COALESCE($provider_session_id, sessions.provider_session_id),
      model = COALESCE($model, sessions.model),
      title = COALESCE($title, sessions.title)
  `),
  updateStatus: db.prepare(`UPDATE sessions SET status = $status, updated_at = $now WHERE id = $id`),
  updateTitle: db.prepare(`UPDATE sessions SET title = $title, updated_at = $now WHERE id = $id`),
  list: db.prepare(`SELECT * FROM sessions WHERE tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%' ORDER BY last_message_at DESC LIMIT $limit`),
  archive: db.prepare(`UPDATE sessions SET archived = 1, archived_at = $now, updated_at = $now WHERE id = $id`),
  unarchive: db.prepare(`UPDATE sessions SET archived = 0, archived_at = NULL, updated_at = $now WHERE id = $id`),
  listArchived: db.prepare(`SELECT * FROM sessions WHERE tags LIKE '%"archived"%' ORDER BY archived_at DESC, updated_at DESC LIMIT $limit`),
  updateTags: db.prepare(`UPDATE sessions SET tags = $tags, updated_at = $now WHERE id = $id`),
  get: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
  listCwds: db.prepare(`
    SELECT DISTINCT cwd
    FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
  `),
  hasMoveContext: db.prepare(`
    SELECT 1
    FROM events
    WHERE session_id = $session_id
      AND type = 'user'
      AND instr(data, $marker) > 0
    LIMIT 1
  `),
  // Events
  addEvent: db.prepare(`
    INSERT INTO events (session_id, seq, type, subtype, data, created_at)
    VALUES ($session_id, $seq, $type, $subtype, $data, $created_at)
  `),
  getEvents: db.prepare(`SELECT * FROM events WHERE session_id = $session_id AND seq > $after_seq ORDER BY seq ASC`),
  getLatestConfigEvent: db.prepare(`
    SELECT * FROM events
    WHERE session_id = $session_id AND type = 'system' AND (subtype = 'config_updated' OR subtype = 'init')
    ORDER BY seq DESC
    LIMIT 1
  `),
  getLatestResultEvent: db.prepare(`
    SELECT data FROM events
    WHERE session_id = $session_id AND type = 'result'
    ORDER BY seq DESC
    LIMIT 1
  `),
  getResultEvents: db.prepare(`
    SELECT data FROM events
    WHERE session_id = $session_id AND type = 'result'
    ORDER BY seq ASC
  `),
  getMaxSeq: db.prepare(`SELECT COALESCE(MAX(seq), 0) as max_seq FROM events WHERE session_id = $session_id`),
  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (
      session_id, seq, role, content, uuid, thinking, tool_calls_json,
      cost_usd, duration_ms, model, turns, created_at
    ) VALUES (
      $session_id, $seq, $role, $content, $uuid, $thinking, $tool_calls_json,
      $cost_usd, $duration_ms, $model, $turns, $created_at
    )
  `),
  getMessages: db.prepare(`
    SELECT *
    FROM messages
    WHERE session_id = $session_id
    ORDER BY COALESCE(seq, 0) ASC, created_at ASC, id ASC
  `),
  // Drafts
  getDraft: db.prepare(`SELECT draft_text FROM sessions WHERE id = $id`),
  setDraft: db.prepare(`UPDATE sessions SET draft_text = $draft_text WHERE id = $id`),
  // UI State
  getUiState: db.prepare(`SELECT ui_state FROM sessions WHERE id = $id`),
  setUiState: db.prepare(`UPDATE sessions SET ui_state = $ui_state WHERE id = $id`),
  // Action Executions
  insertExecution: db.prepare(`
    INSERT INTO action_executions (action_name, action_scope, status, started_at, config_snapshot)
    VALUES ($action_name, $action_scope, $status, $started_at, $config_snapshot)
  `),
  updateExecution: db.prepare(`
    UPDATE action_executions SET
      status = COALESCE($status, status),
      completed_at = COALESCE($completed_at, completed_at),
      run_count = COALESCE($run_count, run_count),
      cycle_count = COALESCE($cycle_count, cycle_count),
      total_cost_usd = COALESCE($total_cost_usd, total_cost_usd)
    WHERE id = $id
  `),
  getExecutions: db.prepare(`
    SELECT * FROM action_executions
    WHERE action_name = $action_name
      AND ($action_scope IS NULL OR action_scope = $action_scope OR action_scope IS NULL)
    ORDER BY id DESC LIMIT $limit
  `),
  getActiveExecutions: db.prepare(`
    SELECT * FROM action_executions
    WHERE action_name = $action_name
      AND status = 'running'
      AND ($action_scope IS NULL OR action_scope = $action_scope OR action_scope IS NULL)
  `),
  // Action Runs
  insertActionRun: db.prepare(`
    INSERT INTO action_runs (action_name, action_scope, session_id, run_number, status, started_at, cycle_number, trigger_type, user_profile, execution_id)
    VALUES ($action_name, $action_scope, $session_id, $run_number, $status, $started_at, $cycle_number, $trigger_type, $user_profile, $execution_id)
  `),
  updateActionRun: db.prepare(`
    UPDATE action_runs SET
      status = COALESCE($status, status),
      summary = COALESCE($summary, summary),
      completed_at = COALESCE($completed_at, completed_at),
      cost_usd = COALESCE($cost_usd, cost_usd),
      error = COALESCE($error, error),
      session_id = COALESCE($session_id, session_id),
      after_run_error = COALESCE($after_run_error, after_run_error),
      attempts = COALESCE($attempts, attempts),
      verify_error = COALESCE($verify_error, verify_error),
      warning = COALESCE($warning, warning)
    WHERE id = $id
  `),
  getActionRuns: db.prepare(`
    SELECT id, action_name, session_id, run_number, status, summary, started_at, completed_at, cost_usd, error, cycle_number, trigger_type, after_run_error, user_profile, attempts, verify_error, warning, execution_id
    FROM action_runs
    WHERE action_name = $action_name
      AND ($action_scope IS NULL OR action_scope = $action_scope OR action_scope IS NULL)
    ORDER BY run_number DESC LIMIT $limit
  `),
  getRunsByExecution: db.prepare(`
    SELECT id, action_name, session_id, run_number, status, summary, started_at, completed_at, cost_usd, error, cycle_number, trigger_type, after_run_error, user_profile, attempts, verify_error, warning, execution_id
    FROM action_runs WHERE execution_id = $execution_id
    ORDER BY run_number ASC
  `),
  getRunSummaries: db.prepare(`
    SELECT run_number, summary, completed_at FROM (
      SELECT run_number, summary, completed_at
      FROM action_runs
      WHERE action_name = $action_name
        AND ($action_scope IS NULL OR action_scope = $action_scope OR action_scope IS NULL)
        AND status = 'done'
        AND summary IS NOT NULL
      ORDER BY run_number DESC LIMIT $limit
    ) ORDER BY run_number ASC
  `),
  getNextRunNumber: db.prepare(`
    SELECT COALESCE(MAX(run_number), 0) + 1 AS next
    FROM action_runs
    WHERE action_name = $action_name
      AND ($action_scope IS NULL OR action_scope = $action_scope OR action_scope IS NULL)
  `),
  // Session Artifacts
  insertSessionArtifact: db.prepare(`
    INSERT INTO session_artifacts (
      session_id, seq, target_message_uuid, action_name, action_run_id,
      name, mime, path, preview_text, metadata_json, created_at
    )
    VALUES (
      $session_id, $seq, $target_message_uuid, $action_name, $action_run_id,
      $name, $mime, $path, $preview_text, $metadata_json, $created_at
    )
  `),
  getSessionArtifact: db.prepare(`
    SELECT *
    FROM session_artifacts
    WHERE session_id = $session_id AND id = $id
  `),
  listSessionArtifacts: db.prepare(`
    SELECT *
    FROM session_artifacts
    WHERE session_id = $session_id
    ORDER BY created_at ASC, id ASC
  `),
  // Web Positions
  getWebPositions: db.prepare(`
    SELECT node_id, x, y, pinned FROM web_positions WHERE scope = $scope
  `),
  upsertWebPosition: db.prepare(`
    INSERT INTO web_positions (node_id, scope, x, y, pinned, updated_at)
    VALUES ($node_id, $scope, $x, $y, $pinned, $now)
    ON CONFLICT(node_id, scope) DO UPDATE SET
      x = $x, y = $y, pinned = $pinned, updated_at = $now
  `),
  deleteWebPositions: db.prepare(`
    DELETE FROM web_positions WHERE scope = $scope
  `),
  deleteWebPosition: db.prepare(`
    DELETE FROM web_positions WHERE node_id = $node_id AND scope = $scope
  `),
};

// ── Session Functions ──

export function upsertSession(opts: {
  id: string;
  preview: string;
  profile?: string;
  provider?: string;
  providerSessionId?: string;
  model?: string;
  status?: string;
  messageCount: number;
  costUsd: number;
  lastPrompt?: string;
  lastResponse?: string;
  cwd?: string;
  actionName?: string;
  userProfile?: string;
  parentSessionId?: string;
  branchMessageUuid?: string;
  title?: string;
}) {
  const t0 = performance.now();
  stmts.upsert.run({
    $id: opts.id,
    $preview: opts.preview,
    $profile: opts.profile ?? null,
    $provider: opts.provider ?? null,
    $provider_session_id: opts.providerSessionId ?? null,
    $model: opts.model ?? null,
    $status: opts.status ?? "done",
    $now: Date.now(),
    $message_count: opts.messageCount,
    $total_cost_usd: opts.costUsd,
    $last_prompt: opts.lastPrompt ?? null,
    $last_response: opts.lastResponse ?? null,
    $cwd: opts.cwd ?? null,
    $action_name: opts.actionName ?? null,
    $user_profile: opts.userProfile ?? null,
    $parent_session_id: opts.parentSessionId ?? null,
    $branch_message_uuid: opts.branchMessageUuid ?? null,
    $title: opts.title ?? null,
  });
  // Index title/preview in FTS for search
  if (opts.title || opts.preview) {
    indexSessionTitle(opts.id, opts.title ?? "", opts.preview);
  }
  const ms = performance.now() - t0;
  if (ms > 5) console.log(`[DB-TIMING] upsertSession ${ms.toFixed(1)}ms session=${opts.id.slice(0,8)} status=${opts.status}`);
}

/** Project roots referenced by persisted sessions, used to restore project-scoped move state. */
export function listSessionCwds(): string[] {
  return (stmts.listCwds.all() as Array<{ cwd: string }>).map((row) => row.cwd);
}

/** Whether a move context block has already been injected into this logical session. */
export function sessionHasMoveContext(sessionId: string, moveName: string): boolean {
  const marker = `<!-- move:${moveName} -->`;
  return !!stmts.hasMoveContext.get({
    $session_id: sessionId,
    $marker: marker,
  });
}

export function renameSession(oldId: string, newId: string) {
  if (oldId === newId) return;
  db.transaction(() => {
    db.run("PRAGMA defer_foreign_keys = ON");
    db.prepare(`UPDATE sessions SET id = $new WHERE id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE messages SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE events SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE session_artifacts SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE checkpoints SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE file_observations SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    db.prepare(`UPDATE action_runs SET session_id = $new WHERE session_id = $old`).run({ $old: oldId, $new: newId });
    // FTS5 virtual tables don't support UPDATE on session_id, so delete + re-insert
    db.prepare(`DELETE FROM search_index_v2 WHERE session_id = $old`).run({ $old: oldId });
  })();
}

/** Persist the execution backend's native conversation/thread identity. */
export function updateProviderSessionId(sessionId: string, providerSessionId: string): void {
  db.prepare(`UPDATE sessions SET provider_session_id = $provider_id WHERE id = $id`)
    .run({ $id: sessionId, $provider_id: providerSessionId });
}

/** Provider IDs observed in init events, oldest first, for legacy recovery only. */
export function getObservedProviderSessionIds(sessionId: string): string[] {
  const rows = db.prepare(`
    SELECT data FROM events
    WHERE session_id = $id AND type = 'system' AND subtype = 'init'
    ORDER BY created_at ASC, id ASC
  `).all({ $id: sessionId }) as { data: string }[];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    try {
      const id = JSON.parse(row.data)?.session_id;
      if (typeof id === "string" && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    } catch { /* malformed legacy event */ }
  }
  return ids;
}

export function updateSessionStatus(id: string, status: string) {
  const t0 = performance.now();
  stmts.updateStatus.run({ $id: id, $status: status, $now: Date.now() });
  const t1 = performance.now();
  // Auto-prune stream events when session completes
  if (status === "idle" || status === "done") {
    try { pruneSessionEvents(id); } catch (e) {
      console.error(`[db] Auto-prune failed for session ${id}:`, e);
    }
  }
  const ms = performance.now() - t0;
  if (ms > 5) console.log(`[DB-TIMING] updateSessionStatus ${ms.toFixed(1)}ms (update=${(t1-t0).toFixed(1)}ms prune=${(performance.now()-t1).toFixed(1)}ms) session=${id.slice(0,8)} status=${status}`);
}

export function updateSessionTitle(id: string, title: string | null) {
  stmts.updateTitle.run({ $id: id, $title: title, $now: Date.now() });
  // Re-index title in FTS
  const row = stmts.get.get({ $id: id }) as SessionRow | null;
  if (row) indexSessionTitle(id, title ?? "", row.preview);
}

export function listSessions(limit = 50): SessionRow[] {
  const t0 = performance.now();
  const result = stmts.list.all({ $limit: limit }) as SessionRow[];
  const ms = performance.now() - t0;
  if (ms > 5) console.log(`[DB-TIMING] listSessions rows=${result.length} ${ms.toFixed(1)}ms`);
  return result;
}

/** List sessions spawned by a specific action */
export function listSessionsByAction(actionName: string, limit = 50): SessionRow[] {
  return db.prepare(
    `SELECT * FROM sessions WHERE tags NOT LIKE '%"archived"%' AND action_name = $action ORDER BY last_message_at DESC LIMIT $limit`
  ).all({ $action: actionName, $limit: limit }) as SessionRow[];
}

/** List sessions whose CWD is a project root or one of its descendants. */
export function listSessionsForProjects(cwdPrefixes: string[], limit = 50): SessionRow[] {
  if (cwdPrefixes.length === 0) return listSessions(limit);
  const scope = buildProjectCwdScope("cwd", cwdPrefixes);
  const sql = `SELECT * FROM sessions WHERE tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%' AND (${scope.sql}) ORDER BY last_message_at DESC LIMIT ?`;
  const params = [...scope.params, limit];
  return db.prepare(sql).all(...params) as SessionRow[];
}

/** List sessions scoped to a user profile — filters by CWD prefixes AND/OR agent profiles AND/OR user_profile column */
export function listSessionsScoped(
  opts: { cwdPrefixes?: string[]; agentProfiles?: string[]; userProfileName?: string; limit?: number },
): SessionRow[] {
  const limit = opts.limit ?? 50;
  const conditions: string[] = ["tags NOT LIKE '%\"archived\"%'", "tags NOT LIKE '%\"internal\"%'"];
  const params: any[] = [];

  if (opts.userProfileName) {
    conditions.push("(user_profile = ? OR user_profile IS NULL)");
    params.push(opts.userProfileName);
  }

  if (opts.cwdPrefixes && opts.cwdPrefixes.length > 0) {
    const scope = buildProjectCwdScope("cwd", opts.cwdPrefixes);
    conditions.push(`(${scope.sql})`);
    params.push(...scope.params);
  }

  if (opts.agentProfiles && opts.agentProfiles.length > 0) {
    const placeholders = opts.agentProfiles.map(() => "?").join(", ");
    conditions.push(`profile IN (${placeholders})`);
    params.push(...opts.agentProfiles);
  }

  // If no filters provided at all, return nothing (fully empty profile)
  if (!opts.cwdPrefixes?.length && !opts.agentProfiles?.length && !opts.userProfileName) {
    return [];
  }

  const sql = `SELECT * FROM sessions WHERE ${conditions.join(" AND ")} ORDER BY last_message_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params) as SessionRow[];
}

export function getSession(id: string): SessionRow | null {
  return (stmts.get.get({ $id: id }) as SessionRow) ?? null;
}

export function archiveSession(id: string) {
  stmts.archive.run({ $id: id, $now: Date.now() });
  addSessionTag(id, "archived");
}

export function unarchiveSession(id: string) {
  stmts.unarchive.run({ $id: id, $now: Date.now() });
  removeSessionTag(id, "archived");
}

export function listArchivedSessions(limit = 50): SessionRow[] {
  return stmts.listArchived.all({ $limit: limit }) as SessionRow[];
}

// ── Tag Functions ──

/** Parse tags JSON from a session row, safely defaulting to [] */
export function parseTags(raw: string): string[] {
  try { return JSON.parse(raw); } catch { return []; }
}

/** Get tags for a session */
export function getSessionTags(id: string): string[] {
  const row = stmts.get.get({ $id: id }) as SessionRow | null;
  return row ? parseTags(row.tags) : [];
}

/** Replace all tags on a session */
export function updateSessionTags(id: string, tags: string[]) {
  stmts.updateTags.run({ $id: id, $tags: JSON.stringify(tags), $now: Date.now() });
}

/** Add a tag if not already present */
export function addSessionTag(id: string, tag: string) {
  const tags = getSessionTags(id);
  if (!tags.includes(tag)) {
    tags.push(tag);
    updateSessionTags(id, tags);
  }
}

/** Find the most recent non-archived session that has a given tag */
export function getSessionByTag(tag: string): SessionRow | null {
  // Tags column stores JSON arrays: '["tag1","tag2"]'
  // LIKE-match the JSON-quoted tag value within the array
  const pattern = `%"${tag.replace(/[%_]/g, "\\$&")}"%`;
  const row = db.prepare(
    `SELECT * FROM sessions WHERE tags LIKE $pattern ESCAPE '\\' AND tags NOT LIKE '%"archived"%' ORDER BY last_message_at DESC LIMIT 1`,
  ).get({ $pattern: pattern }) as SessionRow | null;
  return row ?? null;
}

/** Find ALL non-archived sessions that have a given tag (newest first).
 *  Used by ctx.sessions.wake to fan a message out to a tagged "team" of sessions. */
export function getSessionsByTag(tag: string, limit = 100): SessionRow[] {
  const pattern = `%"${tag.replace(/[%_]/g, "\\$&")}"%`;
  return db.prepare(
    `SELECT * FROM sessions WHERE tags LIKE $pattern ESCAPE '\\' AND tags NOT LIKE '%"archived"%' ORDER BY last_message_at DESC LIMIT $limit`,
  ).all({ $pattern: pattern, $limit: limit }) as SessionRow[];
}

// ── Scheduled Wakes CRUD ──

export type ScheduledWakeRow = {
  id: string;
  target: string;
  content: string;
  kind: "at" | "every" | "onEvent";
  fire_at: number | null;
  every_ms: number | null;
  on_event: string | null;
  origin_kind: string | null;
  origin_name: string | null;
  cwd: string | null;
  user_profile: string | null;
  created_at: number;
  last_fired_at: number | null;
};

export function insertScheduledWake(row: {
  id: string;
  target: string;
  content: string;
  kind: "at" | "every" | "onEvent";
  fireAt?: number | null;
  everyMs?: number | null;
  onEvent?: string | null;
  originKind?: string | null;
  originName?: string | null;
  cwd?: string | null;
  userProfile?: string | null;
}): void {
  db.prepare(`
    INSERT OR REPLACE INTO scheduled_wakes
      (id, target, content, kind, fire_at, every_ms, on_event, origin_kind, origin_name, cwd, user_profile, created_at, last_fired_at)
    VALUES
      ($id, $target, $content, $kind, $fire_at, $every_ms, $on_event, $origin_kind, $origin_name, $cwd, $user_profile, $created_at, NULL)
  `).run({
    $id: row.id,
    $target: row.target,
    $content: row.content,
    $kind: row.kind,
    $fire_at: row.fireAt ?? null,
    $every_ms: row.everyMs ?? null,
    $on_event: row.onEvent ?? null,
    $origin_kind: row.originKind ?? null,
    $origin_name: row.originName ?? null,
    $cwd: row.cwd ?? null,
    $user_profile: row.userProfile ?? null,
    $created_at: Date.now(),
  });
}

export function listScheduledWakes(): ScheduledWakeRow[] {
  return db.prepare(`SELECT * FROM scheduled_wakes`).all() as ScheduledWakeRow[];
}

export function updateScheduledWakeFireAt(id: string, fireAt: number | null, lastFiredAt: number): void {
  db.prepare(`UPDATE scheduled_wakes SET fire_at = $fire_at, last_fired_at = $last_fired_at WHERE id = $id`)
    .run({ $id: id, $fire_at: fireAt, $last_fired_at: lastFiredAt });
}

export function deleteScheduledWake(id: string): void {
  db.prepare(`DELETE FROM scheduled_wakes WHERE id = $id`).run({ $id: id });
}

/** Remove a tag if present */
export function removeSessionTag(id: string, tag: string) {
  const tags = getSessionTags(id);
  const filtered = tags.filter(t => t !== tag);
  if (filtered.length !== tags.length) {
    updateSessionTags(id, filtered);
  }
}

// ── Event Functions ──

export function addEvent(sessionId: string, seq: number, type: string, subtype: string | null, data: string) {
  const t0 = performance.now();
  stmts.addEvent.run({
    $session_id: sessionId,
    $seq: seq,
    $type: type,
    $subtype: subtype,
    $data: data,
    $created_at: Date.now(),
  });
  const t1 = performance.now();
  indexEvent(sessionId, type, data);
  const t2 = performance.now();
  const insertMs = (t1 - t0).toFixed(1);
  const indexMs = (t2 - t1).toFixed(1);
  if (t2 - t0 > 5) console.log(`[DB-TIMING] addEvent ${type}/${subtype} insert=${insertMs}ms index=${indexMs}ms total=${(t2-t0).toFixed(1)}ms session=${sessionId.slice(0,8)}`);
}

export function getEvents(sessionId: string, afterSeq = 0): EventRow[] {
  const t0 = performance.now();
  const result = stmts.getEvents.all({ $session_id: sessionId, $after_seq: afterSeq }) as EventRow[];
  const ms = performance.now() - t0;
  if (ms > 5) console.log(`[DB-TIMING] getEvents session=${sessionId.slice(0,8)} afterSeq=${afterSeq} rows=${result.length} ${ms.toFixed(1)}ms`);
  return result;
}

export function getStoredSessionConfig(sessionId: string): StoredSessionConfig | null {
  const row = stmts.getLatestConfigEvent.get({ $session_id: sessionId }) as EventRow | null;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    const config = parsed?.config && typeof parsed.config === "object" ? parsed.config : {};
    return {
      provider: config.provider || parsed.provider || undefined,
      model: config.model || parsed.model || undefined,
      effort: config.effort || undefined,
      maxTurns: typeof config.maxTurns === "number" ? config.maxTurns : undefined,
      tools: Array.isArray(config.tools) ? config.tools : undefined,
      disallowedTools: Array.isArray(config.disallowedTools) ? config.disallowedTools : undefined,
      toolStates: config.toolStates && typeof config.toolStates === "object" ? config.toolStates : undefined,
      providerControls: config.providerControls && typeof config.providerControls === "object" ? config.providerControls : undefined,
      cwd: parsed.cwd || undefined,
      additionalDirectories: Array.isArray(parsed.additionalDirectories)
        ? parsed.additionalDirectories
        : (Array.isArray(config.additionalDirectories) ? config.additionalDirectories : undefined),
      loadProjectSettings: typeof parsed.loadProjectSettings === "boolean" ? parsed.loadProjectSettings : undefined,
    };
  } catch {
    return null;
  }
}

export function getLatestSessionUsage(sessionId: string, provider?: string | null): SessionUsageRow | null {
  if (provider === "codex") {
    const rows = stmts.getResultEvents.all({ $session_id: sessionId }) as { data: string }[];
    if (rows.length === 0) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data);
        if (typeof parsed.input_tokens === "number") {
          inputTokens += parsed.input_tokens;
          sawUsage = true;
        }
        if (typeof parsed.output_tokens === "number") {
          outputTokens += parsed.output_tokens;
          sawUsage = true;
        }
        if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
          for (const model of Object.values(parsed.modelUsage as Record<string, any>)) {
            inputTokens += (model?.cacheReadInputTokens ?? 0) + (model?.cacheCreationInputTokens ?? 0);
            sawUsage = true;
          }
        }
      } catch {
        // Ignore malformed historical events and keep aggregating.
      }
    }
    return sawUsage ? { inputTokens, outputTokens } : null;
  }

  const row = stmts.getLatestResultEvent.get({ $session_id: sessionId }) as { data: string } | null;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    let cacheRead = 0, cacheWrite = 0;
    if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
      for (const model of Object.values(parsed.modelUsage as Record<string, any>)) {
        cacheRead += (model?.cacheReadInputTokens ?? 0);
        cacheWrite += (model?.cacheCreationInputTokens ?? 0);
      }
    }
    const rawInput = typeof parsed.input_tokens === "number" ? parsed.input_tokens : null;
    return {
      inputTokens: rawInput !== null ? rawInput + cacheRead + cacheWrite : null,
      outputTokens: typeof parsed.output_tokens === "number" ? parsed.output_tokens : null,
    };
  } catch {
    return null;
  }
}

export function getMaxSeq(sessionId: string): number {
  const row = stmts.getMaxSeq.get({ $session_id: sessionId }) as { max_seq: number };
  return row?.max_seq ?? 0;
}

// ── Checkpoints ──

export type CheckpointRow = {
  id: number;
  session_id: string;
  seq: number;
  commit_hash: string;
  cwd: string;
  manifest_json: string | null;
  created_at: number;
};

export function insertCheckpoint(opts: {
  sessionId: string;
  seq: number;
  commitHash: string;
  cwd: string;
  manifestJson?: string;
}): number {
  const result = db.prepare(
    `INSERT INTO checkpoints (session_id, seq, commit_hash, cwd, manifest_json, created_at) VALUES ($sid, $seq, $hash, $cwd, $manifest, $ts)`
  ).run({
    $sid: opts.sessionId,
    $seq: opts.seq,
    $hash: opts.commitHash,
    $cwd: opts.cwd,
    $manifest: opts.manifestJson ?? null,
    $ts: Date.now(),
  });
  return Number(result.lastInsertRowid);
}

/** Latest checkpoint captured at or before `seq` — the code state before that message ran. */
export function findCheckpointAtOrBefore(sessionId: string, seq: number): CheckpointRow | undefined {
  return db.prepare(
    `SELECT * FROM checkpoints WHERE session_id = $sid AND seq <= $seq ORDER BY seq DESC, id DESC LIMIT 1`
  ).get({ $sid: sessionId, $seq: seq }) as CheckpointRow | undefined;
}

export function getCheckpointById(id: number): CheckpointRow | undefined {
  return db.prepare(`SELECT * FROM checkpoints WHERE id = $id`).get({ $id: id }) as CheckpointRow | undefined;
}

export function listAllCheckpoints(): CheckpointRow[] {
  return db.prepare(`SELECT * FROM checkpoints ORDER BY cwd, created_at DESC, id DESC`).all() as CheckpointRow[];
}

export type FileObservationRow = {
  id: number;
  session_id: string;
  seq: number;
  provider: string | null;
  tool_call_id: string | null;
  tool_name: string;
  path: string;
  operation: string;
  evidence: "provider-tool-declared";
  details_json: string | null;
  created_at: number;
};

export function insertFileObservation(opts: {
  sessionId: string;
  seq: number;
  provider?: string;
  toolCallId?: string;
  toolName: string;
  path: string;
  operation: string;
  details?: Record<string, unknown>;
}): void {
  db.prepare(`
    INSERT INTO file_observations
      (session_id, seq, provider, tool_call_id, tool_name, path, operation, evidence, details_json, created_at)
    VALUES ($sid, $seq, $provider, $call, $tool, $path, $operation, 'provider-tool-declared', $details, $created)
  `).run({
    $sid: opts.sessionId,
    $seq: opts.seq,
    $provider: opts.provider ?? null,
    $call: opts.toolCallId ?? null,
    $tool: opts.toolName,
    $path: opts.path,
    $operation: opts.operation,
    $details: opts.details ? JSON.stringify(opts.details) : null,
    $created: Date.now(),
  });
}

export function getFileObservations(sessionId: string): FileObservationRow[] {
  return db.prepare(`SELECT * FROM file_observations WHERE session_id = $sid ORDER BY seq, id`)
    .all({ $sid: sessionId }) as FileObservationRow[];
}

/** One session that wrote or edited a given file, with the display fields the UI needs. */
export type FileSessionRef = {
  sessionId: string;
  /** Most recent write/edit of this file within the session. */
  lastTouchedAt: number;
  /** Event seq of that most recent touch. */
  lastSeq: number;
  editCount: number;
  writeCount: number;
  title: string | null;
  lastPrompt: string | null;
  preview: string;
  model: string | null;
  profile: string | null;
  provider: string | null;
  status: string;
  cwd: string | null;
  userProfile: string | null;
};

/**
 * Sessions that wrote or edited `filePath`, most recently touched first.
 *
 * Reads file_observations rather than reconstructing touches from the events
 * table: it is already exactly the write/edit set, and it is four orders of
 * magnitude cheaper (measured 1.9ms vs 7.9s of full events scan).
 *
 * observeDeclaredFileTools stores the provider's raw path with no normalization
 * (session-manager.ts), so a provider that emits relative paths lands relative.
 * Candidates are therefore matched by basename in SQL and re-resolved against
 * each session's cwd here before being accepted.
 */
export function getSessionsForFile(filePath: string, limit = 3): FileSessionRef[] {
  const rawTarget = filePath.trim();
  if (!rawTarget) return [];
  // UI paths (FileBrowser joins with `/`) and provider tool paths often disagree
  // on separators; normalize once so exact-match and samePath agree on Windows.
  const target = normalize(rawTarget);
  const base = basename(target);
  if (!base) return [];

  // LIKE wildcards are literal characters in a filename; escape them.
  const suffix = `%${base.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const rows = db.prepare(`
    SELECT fo.session_id, fo.path, fo.operation, fo.created_at, fo.seq,
           s.title, s.last_prompt, s.preview, s.model, s.profile, s.provider, s.status, s.cwd, s.user_profile
    FROM file_observations fo
    JOIN sessions s ON fo.session_id = s.id
    WHERE fo.path = $exact OR fo.path LIKE $suffix ESCAPE '\\'
    ORDER BY fo.created_at DESC, fo.id DESC
  `).all({ $exact: target, $suffix: suffix }) as Array<{
    session_id: string; path: string; operation: string; created_at: number; seq: number;
    title: string | null; last_prompt: string | null; preview: string; model: string | null;
    profile: string | null; provider: string | null; status: string; cwd: string | null;
    user_profile: string | null;
  }>;

  const pathsEqual = (a: string, b: string): boolean => {
    const na = normalize(a);
    const nb = normalize(b);
    return process.platform === "win32"
      ? na.toLowerCase() === nb.toLowerCase()
      : na === nb;
  };

  const samePath = (candidate: string, cwd: string | null): boolean => {
    const abs = isAbsolute(candidate) ? candidate : cwd ? resolve(cwd, candidate) : null;
    if (!abs) return false;
    return pathsEqual(abs, target);
  };

  const bySession = new Map<string, FileSessionRef>();
  for (const row of rows) {
    if (!samePath(row.path, row.cwd)) continue;
    let ref = bySession.get(row.session_id);
    if (!ref) {
      ref = {
        sessionId: row.session_id,
        lastTouchedAt: row.created_at,
        lastSeq: row.seq,
        editCount: 0,
        writeCount: 0,
        title: row.title,
        lastPrompt: row.last_prompt,
        preview: row.preview,
        model: row.model,
        profile: row.profile,
        provider: row.provider,
        status: row.status,
        cwd: row.cwd,
        userProfile: row.user_profile,
      };
      bySession.set(row.session_id, ref);
    }
    // Rows arrive newest-first, so the first one seen is already the latest.
    if (row.operation === "write") ref.writeCount++; else ref.editCount++;
  }

  return [...bySession.values()]
    .sort((a, b) => b.lastTouchedAt - a.lastTouchedAt)
    .slice(0, Math.max(1, limit));
}

export function insertMessage(opts: {
  sessionId: string;
  seq?: number;
  role: "user" | "assistant" | "system";
  content: string;
  uuid?: string;
  thinking?: string;
  toolCalls?: { id?: string; name: string; input: Record<string, unknown>; result?: string }[];
  costUsd?: number;
  durationMs?: number;
  model?: string;
  turns?: number;
  createdAt?: number;
}) {
  stmts.insertMessage.run({
    $session_id: opts.sessionId,
    $seq: opts.seq ?? null,
    $role: opts.role,
    $content: opts.content,
    $uuid: opts.uuid ?? null,
    $thinking: opts.thinking ?? null,
    $tool_calls_json: opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
    $cost_usd: opts.costUsd ?? null,
    $duration_ms: opts.durationMs ?? null,
    $model: opts.model ?? null,
    $turns: opts.turns ?? null,
    $created_at: opts.createdAt ?? Date.now(),
  });
}

/**
 * Reconcile denormalized session count after abnormal-turn materialization.
 *
 * `last_message_at` is the session-list ordering key, so it means "when did this
 * conversation last move", not "when was this row last written". Pass
 * `touchActivity: false` for a message the harness wrote about a session rather
 * than one produced by the conversation — a reclamation notice must not push a
 * days-old session back to the top of the list.
 */
export function syncSessionMessageCount(
  sessionId: string,
  opts?: { touchActivity?: boolean },
): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE session_id = $sid`)
    .get({ $sid: sessionId }) as { count: number };
  const count = row.count ?? 0;
  const sql = opts?.touchActivity === false
    ? `UPDATE sessions SET message_count = $count, updated_at = $now WHERE id = $sid`
    : `UPDATE sessions SET message_count = $count, last_message_at = $now, updated_at = $now WHERE id = $sid`;
  db.prepare(sql).run({ $sid: sessionId, $count: count, $now: Date.now() });
  return count;
}

function parseToolCalls(raw: string | null): TurnContent["toolCalls"] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const toolCalls = parsed
      .filter((item) => item && typeof item === "object" && typeof item.name === "string")
      .map((item) => ({
        name: item.name,
        input: item.input && typeof item.input === "object" ? item.input as Record<string, unknown> : {},
        ...(typeof item.result === "string" ? { result: item.result } : {}),
      }));
    return toolCalls.length > 0 ? toolCalls : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turns whose thinking + tool payload exceeds this ship as a placeholder the
 * client expands on demand. Chosen so an ordinary coding turn — a handful of
 * file reads and edits — travels whole, while a turn carrying megabytes of tool
 * output does not. It remains a per-turn decision so the same turn renders the
 * same way whether it arrived in the initial page or an older page.
 */
const DETAIL_DEFER_BYTES = 32_768;

type SessionHistoryPageOptions = {
  limit?: number;
  beforeSeq?: number;
  /** Wall-clock paging boundary; preferred over beforeSeq when seq may collide. */
  beforeCreatedAt?: number;
  includeDetails?: boolean;
  preserveEventSequence?: boolean;
};

type SessionTurnsPage = {
  turns: TurnContent[];
  hasMore: boolean;
  /**
   * User prompts that exist before this page's cutoff. A paginated transcript
   * has no way to know where its oldest loaded turn sits in the conversation,
   * so anything numbering turns (the chat ruler) reads 1..N over whatever
   * happens to be loaded without it.
   *
   * Counted from the page boundary rather than the returned turns so a client
   * that prepends pages keeps a stable number. One divergence is accepted: a
   * prompt event carrying no text materializes no user turn, so it is counted
   * here and not rendered.
   */
  olderTurnCount: number;
};

/**
 * Cost, duration, model, and turn count were already columns on every
 * materialized assistant message; only the token and context figures need the
 * turn's `result` event. Reading them here means a session still shows its
 * stats when its events have aged out from under it.
 */
function messageRowMeta(row: MessageRow): TurnMeta | undefined {
  if (row.role !== "assistant") return undefined;
  const meta: TurnMeta = {
    ...(row.cost_usd != null ? { cost: row.cost_usd } : {}),
    ...(row.duration_ms != null ? { duration: row.duration_ms } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.turns != null ? { turns: row.turns } : {}),
  };
  return hasTurnStats(meta) ? meta : undefined;
}

function messageRowsToTurns(rows: MessageRow[]): TurnContent[] {
  if (rows.length === 0) return [];
  return rows.map((row) => {
    const meta = messageRowMeta(row);
    return {
      // Preserve the three roles the transcript can hold. Collapsing anything
      // non-assistant to "user" used to render a harness error notice as if the
      // person had typed it.
      role: row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "user",
      seq: row.seq ?? 0,
      text: row.content,
      ...(row.thinking ? { thinking: row.thinking } : {}),
      ...(row.uuid ? { uuid: row.uuid } : {}),
      ...(parseToolCalls(row.tool_calls_json) ? { toolCalls: parseToolCalls(row.tool_calls_json) } : {}),
      ...(meta ? { meta } : {}),
      timestamp: row.created_at,
    };
  });
}

function getSessionMessagesFromMessageTable(
  sessionId: string,
  options: SessionHistoryPageOptions = {},
): SessionTurnsPage {
  const limit = options.limit;
  if (!limit) {
    const rows = stmts.getMessages.all({ $session_id: sessionId }) as MessageRow[];
    return { turns: messageRowsToTurns(rows), hasMore: false, olderTurnCount: 0 };
  }

  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE session_id = $session_id
        AND ($before_created_at IS NULL OR created_at < $before_created_at)
        AND ($before_created_at IS NOT NULL OR $before_seq IS NULL OR COALESCE(seq, 0) < $before_seq)
      ORDER BY created_at DESC, id DESC
      LIMIT $fetch_limit
    )
    ORDER BY created_at ASC, id ASC
  `).all({
    $session_id: sessionId,
    $before_seq: options.beforeSeq ?? null,
    $before_created_at: options.beforeCreatedAt ?? null,
    $fetch_limit: limit + 1,
  }) as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(rows.length - limit) : rows;
  // Same wall-clock tuple the page was selected with, so a provider sequence
  // reset cannot move old messages ahead of a resumed turn.
  const first = page[0];
  const olderTurnCount = first
    ? ((db.prepare(`
        SELECT COUNT(*) AS count FROM messages
        WHERE session_id = $session_id
          AND role = 'user'
          AND (created_at, id) < ($created_at, $id)
      `).get({
        $session_id: sessionId,
        $created_at: first.created_at,
        $id: first.id,
      }) as { count: number } | null)?.count ?? 0)
    : 0;
  return {
    turns: messageRowsToTurns(page),
    hasMore,
    olderTurnCount,
  };
}

function getSessionMessagesFromEvents(
  sessionId: string,
  options: SessionHistoryPageOptions = {},
  fallbackModel = "",
): SessionTurnsPage {
  const limit = options.limit;
  // Wall-clock order, not seq: a resumed ActiveSession that restarts at seq 0
  // collides with older events, and ORDER BY seq alone interleaves whole turns.
  const eventOrder = `ORDER BY created_at ASC, id ASC`;
  if (!limit) {
    const events = db.prepare(
      `SELECT id, seq, type, subtype, data, created_at FROM events
       WHERE session_id = $sid AND type IN ('user', 'assistant', 'result')
       ${eventOrder}`
    ).all({ $sid: sessionId }) as { id: number; seq: number; type: string; subtype: string | null; data: string; created_at: number }[];
    return { turns: reconstructSessionTurns(events, fallbackModel), hasMore: false, olderTurnCount: 0 };
  }

  // Event-only legacy/interrupted sessions can contain tens of thousands of
  // rows. Start at a recent user-prompt boundary so a cold open never needs to
  // parse the whole transcript just to paint the newest messages.
  //
  // Cut off by created_at (and only fall back to seq for older clients) so a
  // reused seq cannot pull the window back to the first turn of the session.
  const promptLimit = Math.max(1, Math.ceil(limit / 2));
  let beforeCreatedAt: number | null = options.beforeCreatedAt ?? null;
  if (beforeCreatedAt == null && options.beforeSeq != null) {
    // Best-effort: earliest wall-clock among rows with that seq. Unique-seq
    // sessions get a precise boundary; collided seqs degrade to "no older".
    const boundary = db.prepare(`
      SELECT MIN(created_at) AS created_at FROM events
      WHERE session_id = $sid AND seq = $seq
    `).get({ $sid: sessionId, $seq: options.beforeSeq }) as { created_at: number | null } | null;
    beforeCreatedAt = boundary?.created_at ?? null;
  }

  const cutoff = db.prepare(`
    SELECT MIN(created_at) AS created_at FROM (
      SELECT created_at FROM events
      WHERE session_id = $sid
        AND type = 'user' AND subtype = 'prompt'
        AND ($before_created_at IS NULL OR created_at < $before_created_at)
      ORDER BY created_at DESC
      LIMIT $prompt_limit
    )
  `).get({
    $sid: sessionId,
    $before_created_at: beforeCreatedAt,
    $prompt_limit: promptLimit,
  }) as { created_at: number | null } | null;

  if (!cutoff?.created_at) return { turns: [], hasMore: false, olderTurnCount: 0 };
  const events = db.prepare(
    `SELECT id, seq, type, subtype, data, created_at FROM events
     WHERE session_id = $sid AND type IN ('user', 'assistant', 'result')
       AND created_at >= $cutoff
       AND ($before_created_at IS NULL OR created_at < $before_created_at)
     ${eventOrder}`
  ).all({
    $sid: sessionId,
    $cutoff: cutoff.created_at,
    $before_created_at: beforeCreatedAt,
  }) as { id: number; seq: number; type: string; subtype: string | null; data: string; created_at: number }[];

  // One count answers both questions: whether an older page exists, and how far
  // into the conversation this page starts.
  const older = db.prepare(`
    SELECT COUNT(*) AS count FROM events
    WHERE session_id = $sid AND type = 'user' AND subtype = 'prompt' AND created_at < $cutoff
  `).get({ $sid: sessionId, $cutoff: cutoff.created_at }) as { count: number } | null;
  const olderTurnCount = older?.count ?? 0;
  return {
    turns: reconstructSessionTurns(events, fallbackModel),
    hasMore: olderTurnCount > 0,
    olderTurnCount,
  };
}

/**
 * Fill in the token and context figures the `messages` table has no columns for.
 *
 * Both history paths key an assistant turn on the seq of the event that closed
 * it, but an interrupted turn is materialized at the interrupt's seq — before
 * its own `result` arrives. So each result claims the newest assistant turn at
 * or before it rather than requiring an exact seq match. Values already read
 * from message columns survive anything the event does not report.
 */
function attachResultEventMeta(
  sessionId: string,
  turns: TurnContent[],
  fallbackModel: string,
): TurnContent[] {
  const assistants: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i]!.role === "assistant") assistants.push(i);
  }
  if (assistants.length === 0) return turns;

  const rows = db.prepare(
    `SELECT seq, data FROM events
     WHERE session_id = $sid AND type = 'result' AND seq >= $min
     ORDER BY seq ASC`
  ).all({ $sid: sessionId, $min: turns[assistants[0]!]!.seq }) as { seq: number; data: string }[];
  if (rows.length === 0) return turns;

  const next = [...turns];
  let cursor = 0;
  for (const row of rows) {
    let target = -1;
    while (cursor < assistants.length && next[assistants[cursor]!]!.seq <= row.seq) {
      target = assistants[cursor]!;
      cursor++;
    }
    if (target < 0) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.data); } catch { continue; }
    const meta = turnMetaFromResultEvent(parsed, fallbackModel);
    if (!hasTurnStats(meta)) continue;
    const reported = Object.fromEntries(
      Object.entries(meta).filter(([, value]) => value !== undefined),
    ) as TurnMeta;
    next[target] = { ...next[target]!, meta: { ...next[target]!.meta, ...reported } };
  }
  return next;
}

// ── Draft Functions ──

export function getDraft(sessionId: string): string {
  const row = stmts.getDraft.get({ $id: sessionId }) as { draft_text: string } | null;
  return row?.draft_text ?? "";
}

export function setDraft(sessionId: string, text: string) {
  stmts.setDraft.run({ $id: sessionId, $draft_text: text });
}

// ── Session UI State ──

export function getSessionUiState(sessionId: string): Record<string, unknown> {
  const row = stmts.getUiState.get({ $id: sessionId }) as { ui_state: string } | null;
  try { return JSON.parse(row?.ui_state ?? "{}"); } catch { return {}; }
}

export function patchSessionUiState(sessionId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const current = getSessionUiState(sessionId);
  const merged = { ...current, ...patch };
  stmts.setUiState.run({ $id: sessionId, $ui_state: JSON.stringify(merged) });
  return merged;
}

// ── Web Positions ──

export type WebPosition = { nodeId: string; x: number; y: number; pinned: boolean };

export function getWebPositions(scope: string): WebPosition[] {
  const rows = stmts.getWebPositions.all({ $scope: scope }) as { node_id: string; x: number; y: number; pinned: number }[];
  return rows.map(r => ({ nodeId: r.node_id, x: r.x, y: r.y, pinned: r.pinned === 1 }));
}

export function upsertWebPositions(scope: string, positions: { nodeId: string; x: number; y: number; pinned?: boolean }[]) {
  const now = Date.now();
  db.transaction(() => {
    for (const p of positions) {
      stmts.upsertWebPosition.run({
        $node_id: p.nodeId,
        $scope: scope,
        $x: p.x,
        $y: p.y,
        $pinned: p.pinned ? 1 : 0,
        $now: now,
      });
    }
  })();
}

export function deleteWebPositions(scope: string) {
  stmts.deleteWebPositions.run({ $scope: scope });
}

export function deleteWebPosition(scope: string, nodeId: string) {
  stmts.deleteWebPosition.run({ $node_id: nodeId, $scope: scope });
}

// ── Branching Functions ──

/** Copy events from source session to target, up to maxSeq (inclusive). Re-numbers seq from 1. */
export function copyEventsToSession(sourceId: string, targetId: string, maxSeq: number): number {
  const events = db.prepare(
    `SELECT type, subtype, data FROM events WHERE session_id = $sid AND seq <= $max ORDER BY seq ASC`
  ).all({ $sid: sourceId, $max: maxSeq }) as { type: string; subtype: string | null; data: string }[];

  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO events (session_id, seq, type, subtype, data, created_at)
    VALUES ($sid, $seq, $type, $subtype, $data, $created_at)
  `);

  db.transaction(() => {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      insert.run({
        $sid: targetId,
        $seq: i + 1,
        $type: ev.type,
        $subtype: ev.subtype,
        $data: ev.data,
        $created_at: now,
      });
    }
  })();

  return events.length;
}

/** Copy high-level semantic messages for a branch. Keeps UI history intact after new turns add messages. */
export function copyMessagesToSession(sourceId: string, targetId: string, maxSeq: number): number {
  const messages = db.prepare(`
    SELECT seq, role, content, uuid, thinking, tool_calls_json, cost_usd, duration_ms, model, turns
    FROM messages
    WHERE session_id = $sid AND COALESCE(seq, 0) <= $max
    ORDER BY COALESCE(seq, 0) ASC, created_at ASC, id ASC
  `).all({ $sid: sourceId, $max: maxSeq }) as {
    seq: number | null;
    role: string;
    content: string;
    uuid: string | null;
    thinking: string | null;
    tool_calls_json: string | null;
    cost_usd: number | null;
    duration_ms: number | null;
    model: string | null;
    turns: number | null;
  }[];

  const now = Date.now();
  db.transaction(() => {
    for (const msg of messages) {
      stmts.insertMessage.run({
        $session_id: targetId,
        $seq: msg.seq,
        $role: msg.role,
        $content: msg.content,
        $uuid: msg.uuid,
        $thinking: msg.thinking,
        $tool_calls_json: msg.tool_calls_json,
        $cost_usd: msg.cost_usd,
        $duration_ms: msg.duration_ms,
        $model: msg.model,
        $turns: msg.turns,
        $created_at: now,
      });
    }
  })();

  return messages.length;
}

/** Clear branch fields so a forked session resumes normally next time */
export function clearBranchFields(sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET parent_session_id = NULL, branch_message_uuid = NULL WHERE id = $id`
  ).run({ $id: sessionId });
}

/** Find the SDK assistant message UUID at or before the given seq */
export function findAssistantUuid(sessionId: string, maxSeq: number): string | null {
  const row = db.prepare(
    `SELECT data FROM events WHERE session_id = $sid AND type = 'assistant' AND seq <= $max ORDER BY seq DESC LIMIT 1`
  ).get({ $sid: sessionId, $max: maxSeq }) as { data: string } | null;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    return parsed.uuid ?? null;
  } catch {
    return null;
  }
}

// ── Action Execution Functions ──

export type ExecutionRow = {
  id: number;
  action_name: string;
  action_scope: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  run_count: number;
  cycle_count: number;
  total_cost_usd: number;
  config_snapshot: string | null;
};

export function insertExecution(actionName: string, actionScope?: string | null, configSnapshot?: string): number {
  if (configSnapshot === undefined && typeof actionScope === "string" && actionScope.trim().startsWith("{")) {
    configSnapshot = actionScope;
    actionScope = null;
  }
  stmts.insertExecution.run({
    $action_name: actionName,
    $action_scope: actionScope ?? null,
    $status: "running",
    $started_at: Date.now(),
    $config_snapshot: configSnapshot ?? null,
  });
  return Number((db.query("SELECT last_insert_rowid() as id").get() as any).id);
}

export function updateExecution(id: number, updates: {
  status?: string;
  completedAt?: number;
  runCount?: number;
  cycleCount?: number;
  totalCostUsd?: number;
}) {
  stmts.updateExecution.run({
    $id: id,
    $status: updates.status ?? null,
    $completed_at: updates.completedAt ?? null,
    $run_count: updates.runCount ?? null,
    $cycle_count: updates.cycleCount ?? null,
    $total_cost_usd: updates.totalCostUsd ?? null,
  });
}

export function getExecutions(actionName: string, limit = 20, actionScope?: string | null): ExecutionRow[] {
  return stmts.getExecutions.all({ $action_name: actionName, $action_scope: actionScope ?? null, $limit: limit }) as ExecutionRow[];
}

export function getActiveExecutions(actionName: string, actionScope?: string | null): ExecutionRow[] {
  return stmts.getActiveExecutions.all({ $action_name: actionName, $action_scope: actionScope ?? null }) as ExecutionRow[];
}

export function getRunsByExecution(executionId: number): RunMeta[] {
  const rows = stmts.getRunsByExecution.all({ $execution_id: executionId }) as any[];
  return rows.map(mapRunRow);
}

// ── Action Run Functions ──

import type { RunSummary, RunMeta } from "./action-types";

function mapRunRow(r: any): RunMeta {
  return {
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
    attempts: r.attempts ?? 1,
    verifyError: r.verify_error ?? null,
    warning: r.warning ?? null,
    executionId: r.execution_id ?? null,
  };
}

export function insertActionRun(
  actionName: string,
  actionScopeOrRunNumber: string | null | undefined | number,
  runNumberOrSessionId: number | string | null,
  sessionIdOrStartedAt: string | null | number,
  startedAtOrCycleNumber?: number,
  cycleNumberOrTriggerType: number | string = 1,
  triggerTypeOrUserProfile?: string | null,
  userProfileOrExecutionId?: string | null | number,
  executionIdArg?: number,
): number {
  const scopedCall = typeof actionScopeOrRunNumber !== "number";
  const actionScope = scopedCall ? actionScopeOrRunNumber : null;
  const runNumber = scopedCall ? runNumberOrSessionId as number : actionScopeOrRunNumber;
  const sessionId = scopedCall ? sessionIdOrStartedAt as string | null : runNumberOrSessionId as string | null;
  const startedAt = scopedCall ? startedAtOrCycleNumber! : sessionIdOrStartedAt as number;
  const cycleNumber = scopedCall ? cycleNumberOrTriggerType as number : startedAtOrCycleNumber ?? 1;
  const triggerType = scopedCall
    ? triggerTypeOrUserProfile ?? undefined
    : typeof cycleNumberOrTriggerType === "string" ? cycleNumberOrTriggerType : undefined;
  const userProfile = scopedCall ? userProfileOrExecutionId as string | null | undefined : triggerTypeOrUserProfile ?? undefined;
  const executionId = scopedCall ? executionIdArg : userProfileOrExecutionId as number | undefined;

  stmts.insertActionRun.run({
    $action_name: actionName,
    $action_scope: actionScope ?? null,
    $session_id: sessionId,
    $run_number: runNumber,
    $status: "running",
    $started_at: startedAt,
    $cycle_number: cycleNumber,
    $trigger_type: triggerType ?? null,
    $user_profile: userProfile ?? null,
    $execution_id: executionId ?? null,
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
  attempts?: number;
  verifyError?: string;
  warning?: string;
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
    $attempts: updates.attempts ?? null,
    $verify_error: updates.verifyError ?? null,
    $warning: updates.warning ?? null,
  });
}

export function getActionRuns(actionName: string, limit = 20, actionScope?: string | null): RunMeta[] {
  const rows = stmts.getActionRuns.all({ $action_name: actionName, $action_scope: actionScope ?? null, $limit: limit }) as any[];
  return rows.map(mapRunRow);
}

export function getRunSummaries(actionName: string, limit = 5, actionScope?: string | null): RunSummary[] {
  const rows = stmts.getRunSummaries.all({ $action_name: actionName, $action_scope: actionScope ?? null, $limit: limit }) as any[];
  return rows.map(r => ({
    runNumber: r.run_number,
    summary: r.summary,
    completedAt: r.completed_at,
  }));
}

export function getNextRunNumber(actionName: string, actionScope?: string | null): number {
  const row = stmts.getNextRunNumber.get({ $action_name: actionName, $action_scope: actionScope ?? null }) as { next: number };
  return row.next;
}

export function clearActionRuns(actionName: string, actionScope?: string | null): void {
  db.prepare(`
    DELETE FROM action_runs
    WHERE action_name = $name
      AND ($scope IS NULL OR action_scope = $scope OR action_scope IS NULL)
  `).run({ $name: actionName, $scope: actionScope ?? null });
}

export function insertSessionArtifact(opts: {
  sessionId: string;
  seq: number;
  targetMessageUuid?: string;
  actionName?: string;
  actionRunId?: number | null;
  name: string;
  mime: string;
  path: string;
  createdAt?: number;
  previewText?: string;
  metadata?: Record<string, unknown>;
}): number {
  stmts.insertSessionArtifact.run({
    $session_id: opts.sessionId,
    $seq: opts.seq,
    $target_message_uuid: opts.targetMessageUuid ?? null,
    $action_name: opts.actionName ?? null,
    $action_run_id: opts.actionRunId ?? null,
    $name: opts.name,
    $mime: opts.mime,
    $path: opts.path,
    $preview_text: opts.previewText ?? null,
    $metadata_json: opts.metadata ? JSON.stringify(opts.metadata) : null,
    $created_at: opts.createdAt ?? Date.now(),
  });
  return Number((db.query("SELECT last_insert_rowid() as id").get() as any).id);
}

export function getSessionArtifact(sessionId: string, id: number): SessionArtifactRow | null {
  return (stmts.getSessionArtifact.get({ $session_id: sessionId, $id: id }) as SessionArtifactRow | null) ?? null;
}

function parseArtifactMetadata(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function toSessionArtifactValue(row: SessionArtifactRow): SessionArtifactValue {
  const metadata = parseArtifactMetadata(row.metadata_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    ...(row.target_message_uuid ? { targetMessageUuid: row.target_message_uuid } : {}),
    name: row.name,
    mime: row.mime,
    url: `/api/sessions/${encodeURIComponent(row.session_id)}/artifacts/${row.id}`,
    ...(row.action_name ? { sourceAction: row.action_name } : {}),
    createdAt: row.created_at,
    ...(row.preview_text ? { previewText: row.preview_text } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

// ── Message Content Reconstruction ──

export type SessionMessageHistory = {
  messages: TurnContent[];
  recoveredFromEvents: boolean;
  hasMore: boolean;
  oldestSeq: number | null;
  /** Oldest wall-clock position in this page; stable across reused provider seq values. */
  oldestCreatedAt: number | null;
  /** User prompts preceding this page — what turn numbering has to start from. */
  olderTurnCount: number;
};

function attachArtifactsToTurn(sessionId: string, turn: TurnContent, alternateSeq?: number): TurnContent {
  if (turn.role !== "assistant") return turn;
  const rows = db.prepare(`
    SELECT * FROM session_artifacts
    WHERE session_id = $session_id
      AND (
        seq = $seq
        OR ($alternate_seq IS NOT NULL AND seq = $alternate_seq)
        OR ($uuid IS NOT NULL AND target_message_uuid = $uuid)
      )
    ORDER BY created_at ASC, id ASC
  `).all({
    $session_id: sessionId,
    $seq: turn.seq,
    $alternate_seq: alternateSeq ?? null,
    $uuid: turn.uuid ?? null,
  }) as SessionArtifactRow[];
  if (rows.length === 0) return turn;
  const seen = new Set<number>();
  const artifacts = rows
    .filter((row) => !seen.has(row.id) && !!seen.add(row.id))
    .map(toSessionArtifactValue);
  return artifacts.length > 0 ? { ...turn, artifacts } : turn;
}

/** Reconstruct one requested turn without rebuilding the complete transcript. */
export function getSessionMessage(sessionId: string, requestedSeq: number): TurnContent | null {
  const exactEvents = db.prepare(`
    SELECT seq, type, subtype, data, created_at
    FROM events
    WHERE session_id = $sid AND seq = $seq AND type IN ('user', 'assistant', 'result')
    ORDER BY id ASC
  `).all({ $sid: sessionId, $seq: requestedSeq }) as SessionHistoryEventRow[];

  const exactPrompt = exactEvents.find((event) => event.type === "user" && event.subtype === "prompt");
  if (exactPrompt) {
    return reconstructSessionTurns([exactPrompt]).find((turn) => turn.role === "user") ?? null;
  }

  if (exactEvents.length > 0) {
    const start = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS seq
      FROM events
      WHERE session_id = $sid AND type = 'user' AND subtype = 'prompt' AND seq <= $seq
    `).get({ $sid: sessionId, $seq: requestedSeq }) as { seq: number };
    const nextPrompt = db.prepare(`
      SELECT MIN(seq) AS seq
      FROM events
      WHERE session_id = $sid AND type = 'user' AND subtype = 'prompt' AND seq > $seq
    `).get({ $sid: sessionId, $seq: requestedSeq }) as { seq: number | null } | null;
    const requestedIsResult = exactEvents.some((event) => event.type === "result");
    const nextResult = requestedIsResult
      ? requestedSeq
      : (db.prepare(`
          SELECT MIN(seq) AS seq
          FROM events
          WHERE session_id = $sid AND type = 'result' AND seq >= $seq
            AND ($next_prompt IS NULL OR seq < $next_prompt)
        `).get({
          $sid: sessionId,
          $seq: requestedSeq,
          $next_prompt: nextPrompt?.seq ?? null,
        }) as { seq: number | null } | null)?.seq ?? null;
    const endSeq = nextResult ?? ((nextPrompt?.seq ?? null) != null ? nextPrompt!.seq! - 1 : null);
    const events = db.prepare(`
      SELECT seq, type, subtype, data, created_at
      FROM events
      WHERE session_id = $sid AND type IN ('user', 'assistant', 'result')
        AND seq >= $start
        AND ($end IS NULL OR seq <= $end)
      ORDER BY seq ASC, id ASC
    `).all({
      $sid: sessionId,
      $start: start.seq || requestedSeq,
      $end: endSeq,
    }) as SessionHistoryEventRow[];
    const assistant = reconstructSessionTurns(events).findLast((turn) => turn.role === "assistant");
    if (assistant) {
      const materializedSeq = assistant.seq;
      const stableTurn = materializedSeq === requestedSeq ? assistant : { ...assistant, seq: requestedSeq };
      return attachArtifactsToTurn(sessionId, stableTurn, materializedSeq);
    }
  }

  // Very old sessions may only have semantic message rows.
  const row = db.prepare(`
    SELECT * FROM messages
    WHERE session_id = $sid AND seq = $seq
    ORDER BY id DESC LIMIT 1
  `).get({ $sid: sessionId, $seq: requestedSeq }) as MessageRow | null;
  if (!row) return null;
  const turn = messageRowsToTurns([row])[0];
  return turn ? attachArtifactsToTurn(sessionId, turn) : null;
}

/** Return the fastest complete history source, falling back to durable events
 * when they contain an assistant turn newer than semantic materialization. */
export function getSessionMessageHistory(
  sessionId: string,
  options: SessionHistoryPageOptions = {},
): SessionMessageHistory {
  const artifactRows = stmts.listSessionArtifacts.all({ $session_id: sessionId }) as SessionArtifactRow[];
  const artifactsBySeq = new Map<number, SessionArtifactValue[]>();
  const artifactsByUuid = new Map<string, SessionArtifactValue[]>();
  for (const row of artifactRows) {
    const artifact = toSessionArtifactValue(row);
    const seqArtifacts = artifactsBySeq.get(row.seq) ?? [];
    seqArtifacts.push(artifact);
    artifactsBySeq.set(row.seq, seqArtifacts);
    if (row.target_message_uuid) {
      const uuidArtifacts = artifactsByUuid.get(row.target_message_uuid) ?? [];
      uuidArtifacts.push(artifact);
      artifactsByUuid.set(row.target_message_uuid, uuidArtifacts);
    }
  }

  const rawAssistant = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE session_id = $sid AND type = 'assistant'`
  ).get({ $sid: sessionId }) as { max_seq: number };
  const semanticAssistant = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE session_id = $sid AND role = 'assistant'`
  ).get({ $sid: sessionId }) as { max_seq: number };
  const semanticCount = db.prepare(
    `SELECT COUNT(*) AS count FROM messages WHERE session_id = $sid`
  ).get({ $sid: sessionId }) as { count: number };
  const useEventHistory = options.preserveEventSequence || semanticCount.count === 0
    || (rawAssistant.max_seq ?? 0) > (semanticAssistant.max_seq ?? 0);
  // Providers that emit no modelUsage leave the turn's model unnamed; the
  // session's own model is the only honest fallback.
  const sessionModel = (db.prepare(`SELECT model FROM sessions WHERE id = $sid`)
    .get({ $sid: sessionId }) as { model: string | null } | null)?.model ?? "";
  const eventPage = useEventHistory ? getSessionMessagesFromEvents(sessionId, options, sessionModel) : null;
  // Some very old sessions only retained semantic rows. Preserve their text
  // rather than returning an empty event-sequence page.
  const page = eventPage && eventPage.turns.length > 0
    ? eventPage
    : getSessionMessagesFromMessageTable(sessionId, options);
  const recoveredFromEvents = !!eventPage && eventPage.turns.length > 0;
  // The event path already read each result as it closed a turn; only the
  // message-table path needs its token and context figures filled in.
  const turns = recoveredFromEvents
    ? page.turns
    : attachResultEventMeta(sessionId, page.turns, sessionModel);

  const messages = turns.map((turn) => {
    if (turn.role !== "assistant") return turn;
    const artifacts: SessionArtifactValue[] = [];
    const seen = new Set<number>();
    if (turn.uuid) {
      for (const artifact of artifactsByUuid.get(turn.uuid) ?? []) {
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        artifacts.push(artifact);
      }
    }
    for (const artifact of artifactsBySeq.get(turn.seq) ?? []) {
      if (seen.has(artifact.id)) continue;
      seen.add(artifact.id);
      artifacts.push(artifact);
    }
    return artifacts.length > 0 ? { ...turn, artifacts } : turn;
  }).map((turn) => {
    if (options.includeDetails !== false || turn.role !== "assistant") return turn;
    // Defer on weight, not on presence. This used to trigger on any thinking or
    // any single tool call, which meant a 455-byte turn and a 4MB turn were
    // treated identically and effectively every message in a loaded session
    // became a "load N tool calls" button. Below the threshold a turn ships
    // whole and renders exactly as it did live.
    if (estimateTurnDetailBytes(turn) < DETAIL_DEFER_BYTES) return turn;
    const deferredToolCallCount = turn.toolCalls?.length ?? 0;
    const { thinking: _thinking, toolCalls: _toolCalls, ...summary } = turn;
    return {
      ...summary,
      ...(turn.contentBlocks ? { contentBlocks: summarizeContentBlocks(turn.contentBlocks) } : {}),
      detailsDeferred: true,
      // Sent rather than inferred: the client used to guess thinking from the
      // absence of tool calls, which is wrong for any turn that had both.
      deferredHasThinking: !!turn.thinking,
      ...(deferredToolCallCount > 0 ? { deferredToolCallCount } : {}),
    };
  });
  return {
    messages,
    recoveredFromEvents,
    hasMore: page.hasMore,
    oldestSeq: messages.reduce<number | null>((min, turn) => (
      turn.seq > 0 && (min === null || turn.seq < min) ? turn.seq : min
    ), null),
    oldestCreatedAt: messages.reduce<number | null>((min, turn) => (
      turn.timestamp > 0 && (min === null || turn.timestamp < min) ? turn.timestamp : min
    ), null),
    olderTurnCount: page.olderTurnCount,
  };
}

/** Reconstruct structured message content for callers that only need turns. */
export function getSessionMessages(sessionId: string): TurnContent[] {
  return getSessionMessageHistory(sessionId, { preserveEventSequence: true }).messages;
}

// ── Full-Text Search (FTS5 v2) ──
// v2: adds title column (weight 10x), indexes assistant text, recency-blended ranking

// Drop v1 table if it exists (schema changed — needs rebuild)
try { db.run(`DROP TABLE IF EXISTS search_index`); } catch { /* already gone */ }

db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index_v2 USING fts5(
  session_id UNINDEXED,
  role,
  content,
  title,
  tokenize = 'porter unicode61',
  columnsize = 0
)`);

// Set default rank to bm25 with column weights: role=1, content=1, title=10
try { db.run(`INSERT INTO search_index_v2(search_index_v2, rank) VALUES('rank', 'bm25(1.0, 1.0, 10.0)')`); } catch { /* already set */ }

/** Extract text blocks from an assistant event's message.content array */
function extractAssistantText(data: string): string | null {
  try {
    const content = JSON.parse(data)?.message?.content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text) parts.push(block.text);
      if (block.type === "tool_use" && block.name) parts.push(`[tool: ${block.name}]`);
    }
    return parts.length > 0 ? parts.join(" ") : null;
  } catch { return null; }
}

// Populate FTS from existing events + session titles (only if empty)
const ftsCount = (db.prepare(`SELECT COUNT(*) as n FROM search_index_v2`).get() as any).n;
if (ftsCount === 0) {
  const rebuildStmt = db.prepare(
    `INSERT INTO search_index_v2 (session_id, role, content, title) VALUES ($sid, $role, $text, $title)`
  );
  // Index events: user prompts, result summaries, assistant text
  const events = db.prepare(
    `SELECT session_id, type, data FROM events WHERE type IN ('user', 'result', 'assistant')`
  ).all() as any[];
  db.transaction(() => {
    for (const ev of events) {
      let text: string | null = null;
      if (ev.type === "user") {
        try { text = JSON.parse(ev.data)?.message?.content; } catch { /* skip */ }
        if (typeof text !== "string") text = null;
      } else if (ev.type === "result") {
        try { text = JSON.parse(ev.data)?.result; } catch { /* skip */ }
      } else if (ev.type === "assistant") {
        text = extractAssistantText(ev.data);
      }
      if (typeof text === "string" && text.length > 0) {
        rebuildStmt.run({ $sid: ev.session_id, $role: ev.type, $text: text, $title: "" });
      }
    }
    // Index session titles/previews as high-signal rows
    const sessions = db.prepare(`SELECT id, preview, title FROM sessions`).all() as any[];
    for (const s of sessions) {
      const titleText = [s.title, s.preview].filter(Boolean).join(" — ");
      if (titleText) {
        rebuildStmt.run({ $sid: s.id, $role: "title", $text: "", $title: titleText });
      }
    }
  })();
}

/** Insert into FTS index — call alongside addEvent for user/result/assistant events */
export function indexEvent(sessionId: string, type: string, data: string) {
  let text: string | null = null;
  if (type === "user") {
    try {
      const parsed = JSON.parse(data);
      text = parsed?.message?.content;
      if (typeof text !== "string") text = null;
    } catch { return; }
  } else if (type === "result") {
    try { text = JSON.parse(data)?.result; } catch { return; }
  } else if (type === "assistant") {
    text = extractAssistantText(data);
  } else {
    return;
  }
  if (typeof text === "string" && text.length > 0) {
    db.prepare(`INSERT INTO search_index_v2 (session_id, role, content, title) VALUES ($sid, $role, $text, '')`)
      .run({ $sid: sessionId, $role: type, $text: text });
  }
}

/** Index or re-index a session's title/preview in FTS */
export function indexSessionTitle(sessionId: string, title: string, preview?: string) {
  const titleText = [title, preview].filter(Boolean).join(" — ");
  if (!titleText) return;
  // Remove old title row for this session, then insert fresh
  db.prepare(`DELETE FROM search_index_v2 WHERE session_id = $sid AND role = 'title'`)
    .run({ $sid: sessionId });
  db.prepare(`INSERT INTO search_index_v2 (session_id, role, content, title) VALUES ($sid, 'title', '', $title)`)
    .run({ $sid: sessionId, $title: titleText });
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

export function searchSessions(
  query: string,
  limit = 20,
  scope?: { cwdPrefixes?: string[]; agentProfiles?: string[]; userProfileName?: string; role?: string },
): SearchHit[] {
  // Build FTS query — optionally prefix with role column filter
  const baseTerms = query.trim().split(/\s+/).map(t => `"${t}"*`).join(" ");
  const ftsQuery = scope?.role && ["user", "assistant"].includes(scope.role)
    ? `role:"${scope.role}" AND ${baseTerms}`
    : baseTerms;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

  const matchConditions = [
    `search_index_v2 MATCH $fts`,
    `s.tags NOT LIKE '%"archived"%'`,
    `s.tags NOT LIKE '%"internal"%'`,
  ];
  const matchParams: any[] = [ftsQuery];

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

  // Recency-blended ranking: FTS5 rank (bm25 with title weight 10x) is blended
  // with a recency bonus so recent sessions float up when relevance is similar.
  // rank is negative (lower = better), recency term is 0..2 (higher = more recent).
  const now = Date.now();
  const matches = db.prepare(`
    SELECT sid, best_rank, lma,
      (best_rank - 2.0 * (CAST(lma AS REAL) / ${now})) AS blended
    FROM (
      SELECT
        search_index_v2.session_id AS sid,
        MIN(rank) AS best_rank,
        s.last_message_at AS lma
      FROM search_index_v2
      JOIN sessions s ON s.id = search_index_v2.session_id
      WHERE ${matchConditions.join(" AND ")}
      GROUP BY search_index_v2.session_id
    )
    ORDER BY blended
    LIMIT ?
  `).all(...matchParams, limit) as { sid: string; best_rank: number; lma: number }[];

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
          const idx = lower.indexOf(terms[0] ?? "");
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

// ── Event Pruning ──
// After a session completes, prune redundant streaming deltas to save space.
// Keeps assistant/user/system/result events intact — only removes stream_event rows.
// Safety: only prunes sessions that have assembled assistant events (so PI-only
// sessions that lack assistant events keep their stream_events for replay).

const pruneDeleteStmt = db.prepare(`
  DELETE FROM events
  WHERE session_id = $sid
    AND type = 'stream_event'
`);

const hasAssistantEventsStmt = db.prepare(
  `SELECT 1 FROM events WHERE session_id = $sid AND type = 'assistant' LIMIT 1`
);

const markPrunedStmt = db.prepare(`UPDATE sessions SET pruned = 1 WHERE id = $sid`);

/** Prune a single session — delete all stream_event rows if assembled assistant events exist */
export function pruneSessionEvents(sessionId: string): { deleted: number } {
  const t0 = performance.now();
  const hasAssembled = hasAssistantEventsStmt.get({ $sid: sessionId });
  if (!hasAssembled) {
    markPrunedStmt.run({ $sid: sessionId });
    return { deleted: 0 };
  }
  const result = pruneDeleteStmt.run({ $sid: sessionId });
  markPrunedStmt.run({ $sid: sessionId });
  const ms = performance.now() - t0;
  if (result.changes > 0 || ms > 5) {
    console.log(`[DB-TIMING] pruneSessionEvents ${ms.toFixed(1)}ms deleted=${result.changes} session=${sessionId.slice(0, 12)}`);
  }
  return { deleted: result.changes };
}

/** Prune all idle/done sessions that haven't been pruned yet */
export function pruneAllSessionEvents(): { sessions: number; events: number } {
  const unpruned = db.prepare(
    `SELECT id FROM sessions WHERE pruned = 0 AND status IN ('idle', 'done')`
  ).all() as { id: string }[];
  let totalDeleted = 0;
  db.transaction(() => {
    for (const { id } of unpruned) {
      const { deleted } = pruneSessionEvents(id);
      totalDeleted += deleted;
    }
  })();
  if (totalDeleted > 0) {
    console.log(`[db] Pruned ${totalDeleted} stream events across ${unpruned.length} sessions`);
  }
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
    WHERE s.tags NOT LIKE '%"archived"%' AND s.tags NOT LIKE '%"internal"%'
    GROUP BY s.cwd
    ORDER BY bytes DESC
  `).all() as any[];
}

// ── User Stats ──

export type SessionStats = {
  totals: { sessions: number; cost: number; messages: number; firstSession: number | null; lastSession: number | null };
  byProject: { project: string; sessions: number; cost: number; messages: number }[];
  byProfile: { profile: string; sessions: number; cost: number; messages: number }[];
  byModel: { model: string; sessions: number; cost: number }[];
  daily: { day: string; sessions: number; cost: number }[];
  topSessions: { id: string; preview: string; cost: number; messages: number; profile: string | null; cwd: string | null }[];
};

export function getSessionStats(userProfile?: string): SessionStats {
  const base = `tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%'`;
  const upFilter = userProfile ? ` AND (user_profile = ? OR user_profile IS NULL)` : "";
  const params: any[] = userProfile ? [userProfile] : [];

  const totals = db.prepare(`
    SELECT COUNT(*) as sessions, COALESCE(SUM(total_cost_usd), 0) as cost,
           COALESCE(SUM(message_count), 0) as messages,
           MIN(created_at) as firstSession, MAX(last_message_at) as lastSession
    FROM sessions WHERE ${base}${upFilter}
  `).get(...params) as any;

  const byProject = db.prepare(`
    SELECT COALESCE(cwd, '(none)') as project, COUNT(*) as sessions,
           COALESCE(SUM(total_cost_usd), 0) as cost, COALESCE(SUM(message_count), 0) as messages
    FROM sessions WHERE ${base}${upFilter}
    GROUP BY cwd ORDER BY cost DESC LIMIT 20
  `).all(...params) as any[];

  const byProfile = db.prepare(`
    SELECT COALESCE(profile, '(default)') as profile, COUNT(*) as sessions,
           COALESCE(SUM(total_cost_usd), 0) as cost, COALESCE(SUM(message_count), 0) as messages
    FROM sessions WHERE ${base}${upFilter}
    GROUP BY profile ORDER BY cost DESC LIMIT 20
  `).all(...params) as any[];

  const byModel = db.prepare(`
    SELECT COALESCE(model, '(unknown)') as model, COUNT(*) as sessions,
           COALESCE(SUM(total_cost_usd), 0) as cost
    FROM sessions WHERE ${base}${upFilter}
    GROUP BY model ORDER BY cost DESC LIMIT 10
  `).all(...params) as any[];

  // Daily activity for last 60 days
  const since = Date.now() - 60 * 86_400_000;
  const dailyParams = [...params, since];
  const daily = db.prepare(`
    SELECT DATE(created_at / 1000, 'unixepoch') as day, COUNT(*) as sessions,
           COALESCE(SUM(total_cost_usd), 0) as cost
    FROM sessions WHERE ${base}${upFilter} AND created_at > ?
    GROUP BY day ORDER BY day
  `).all(...dailyParams) as any[];

  // Top 5 most expensive sessions
  const topSessions = db.prepare(`
    SELECT id, preview, total_cost_usd as cost, message_count as messages, profile, cwd
    FROM sessions WHERE ${base}${upFilter}
    ORDER BY total_cost_usd DESC LIMIT 5
  `).all(...params) as any[];

  return { totals, byProject, byProfile, byModel, daily, topSessions };
}

// ── Time-Period Cost Stats ──

export type PeriodCosts = {
  today: { cost: number; sessions: number; messages: number };
  week: { cost: number; sessions: number; messages: number };
  month: { cost: number; sessions: number; messages: number };
};

export type UsageBucket = {
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type ProviderUsageTotal = UsageBucket & {
  provider: string;
};

export type ModelUsageTotal = UsageBucket & {
  provider: string;
  model: string;
};

export type ProviderUsageDaily = UsageBucket & {
  day: string;
  provider: string;
};

export type ProviderUsageAnalytics = {
  windowDays: number;
  totals: UsageBucket;
  providers: ProviderUsageTotal[];
  models: ModelUsageTotal[];
  daily: ProviderUsageDaily[];
};

export type DeepAnalyticsMetricRow = {
  key: string;
  sessions: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type DeepAnalyticsBucket = {
  start: number;
  end: number;
  sessionsStarted: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  touches: number;
};

export type DeepAnalyticsSessionRow = {
  id: string;
  preview: string;
  profile: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  createdAt: number;
  lastMessageAt: number;
  totalMessages: number;
  totalCost: number;
  userMessages: number;
  assistantMessages: number;
  assistantTurns: number;
  toolCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DeepAnalyticsHourRow = {
  hour: number;
  userMessages: number;
  assistantTurns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
};

export type DeepAnalytics = {
  range: {
    start: number;
    end: number;
    bucketMs: number;
    bucketCount: number;
  };
  totals: {
    sessionsStarted: number;
    sessionsActive: number;
    userMessages: number;
    assistantMessages: number;
    assistantTurns: number;
    toolCalls: number;
    totalDurationMs: number;
    avgDurationMs: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: number;
  };
  buckets: DeepAnalyticsBucket[];
  byProvider: DeepAnalyticsMetricRow[];
  byModel: DeepAnalyticsMetricRow[];
  byProfile: DeepAnalyticsMetricRow[];
  byProject: DeepAnalyticsMetricRow[];
  byHour: DeepAnalyticsHourRow[];
  sessions: DeepAnalyticsSessionRow[];
};

export function getPeriodCosts(userProfile?: string): PeriodCosts {
  const now = Date.now();
  const todayStart = now - (now % 86_400_000);
  const weekStart = now - 7 * 86_400_000;
  const monthStart = now - 30 * 86_400_000;

  const base = `tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%'`;
  const upFilter = userProfile ? ` AND (user_profile = ? OR user_profile IS NULL)` : "";

  const query = (since: number) => {
    const params: any[] = userProfile ? [userProfile, since] : [since];
    return db.prepare(`
      SELECT COALESCE(SUM(total_cost_usd), 0) as cost, COUNT(*) as sessions,
             COALESCE(SUM(message_count), 0) as messages
      FROM sessions WHERE ${base}${upFilter} AND created_at > ?
    `).get(...params) as any;
  };

  return {
    today: query(todayStart),
    week: query(weekStart),
    month: query(monthStart),
  };
}

function createUsageBucket(): UsageBucket {
  return {
    sessions: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function addUsage(
  bucket: UsageBucket,
  metrics: { turns: number; inputTokens: number; outputTokens: number; totalTokens: number; cost: number },
) {
  bucket.turns += metrics.turns;
  bucket.inputTokens += metrics.inputTokens;
  bucket.outputTokens += metrics.outputTokens;
  bucket.totalTokens += metrics.totalTokens;
  bucket.cost += metrics.cost;
}

function usageDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function getProviderUsageAnalytics(
  opts: { userProfile?: string; days?: number } = {},
): ProviderUsageAnalytics {
  const windowDays = Math.max(1, Math.min(120, opts.days ?? 30));
  const since = Date.now() - windowDays * 86_400_000;
  const upFilter = opts.userProfile ? ` AND (s.user_profile = ? OR s.user_profile IS NULL)` : "";
  const params: any[] = opts.userProfile ? [since, opts.userProfile] : [since];
  const rows = db.prepare(`
    SELECT
      s.id AS session_id,
      COALESCE(s.provider, '(unknown)') AS provider,
      COALESCE(s.model, '(unknown)') AS model,
      e.data,
      e.created_at
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.type = 'result'
      AND s.tags NOT LIKE '%"archived"%'
      AND s.tags NOT LIKE '%"internal"%'
      AND e.created_at >= ?
      ${upFilter}
    ORDER BY e.created_at ASC
  `).all(...params) as {
    session_id: string;
    provider: string;
    model: string;
    data: string;
    created_at: number;
  }[];

  const totals = createUsageBucket();
  const totalSessions = new Set<string>();
  const providerAgg = new Map<string, UsageBucket & { sessionIds: Set<string> }>();
  const modelAgg = new Map<string, UsageBucket & { provider: string; model: string; sessionIds: Set<string> }>();
  const dailyAgg = new Map<string, UsageBucket & { day: string; provider: string; sessionIds: Set<string> }>();

  for (const row of rows) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      continue;
    }

    // Sum cache tokens from modelUsage (present in all stored events since SDK always includes it)
    // New events also have top-level cache_read_tokens/cache_write_tokens, but modelUsage is
    // the authoritative source and works for all historical data too.
    let cacheRead = 0, cacheWrite = 0;
    if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
      for (const model of Object.values(parsed.modelUsage as Record<string, any>)) {
        cacheRead += (model?.cacheReadInputTokens ?? 0);
        cacheWrite += (model?.cacheCreationInputTokens ?? 0);
      }
    }
    const rawInput = typeof parsed.input_tokens === "number" ? parsed.input_tokens : 0;
    const outputTokens = typeof parsed.output_tokens === "number" ? parsed.output_tokens : 0;
    const inputTokens = rawInput + cacheRead + cacheWrite;
    const totalTokens = inputTokens + outputTokens;
    const turns = typeof parsed.num_turns === "number" && parsed.num_turns > 0 ? parsed.num_turns : 1;
    const cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
    const metrics = { turns, inputTokens, outputTokens, totalTokens, cost };
    const provider = row.provider || "(unknown)";
    const model = row.model || "(unknown)";
    const day = usageDay(row.created_at);

    addUsage(totals, metrics);
    totalSessions.add(row.session_id);

    let providerBucket = providerAgg.get(provider);
    if (!providerBucket) {
      providerBucket = { ...createUsageBucket(), sessionIds: new Set<string>() };
      providerAgg.set(provider, providerBucket);
    }
    addUsage(providerBucket, metrics);
    providerBucket.sessionIds.add(row.session_id);

    const modelKey = `${provider}::${model}`;
    let modelBucket = modelAgg.get(modelKey);
    if (!modelBucket) {
      modelBucket = { ...createUsageBucket(), provider, model, sessionIds: new Set<string>() };
      modelAgg.set(modelKey, modelBucket);
    }
    addUsage(modelBucket, metrics);
    modelBucket.sessionIds.add(row.session_id);

    const dailyKey = `${day}::${provider}`;
    let dailyBucket = dailyAgg.get(dailyKey);
    if (!dailyBucket) {
      dailyBucket = { ...createUsageBucket(), day, provider, sessionIds: new Set<string>() };
      dailyAgg.set(dailyKey, dailyBucket);
    }
    addUsage(dailyBucket, metrics);
    dailyBucket.sessionIds.add(row.session_id);
  }

  totals.sessions = totalSessions.size;

  const providers = [...providerAgg.entries()]
    .map(([provider, bucket]) => ({
      provider,
      sessions: bucket.sessionIds.size,
      turns: bucket.turns,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      totalTokens: bucket.totalTokens,
      cost: bucket.cost,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);

  const models = [...modelAgg.values()]
    .map((bucket) => ({
      provider: bucket.provider,
      model: bucket.model,
      sessions: bucket.sessionIds.size,
      turns: bucket.turns,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      totalTokens: bucket.totalTokens,
      cost: bucket.cost,
    }))
    .sort((left, right) => right.totalTokens - left.totalTokens);

  const daily = [...dailyAgg.values()]
    .map((bucket) => ({
      day: bucket.day,
      provider: bucket.provider,
      sessions: bucket.sessionIds.size,
      turns: bucket.turns,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      totalTokens: bucket.totalTokens,
      cost: bucket.cost,
    }))
    .sort((left, right) => left.day.localeCompare(right.day) || left.provider.localeCompare(right.provider));

  return { windowDays, totals, providers, models, daily };
}

function createDeepMetricAccumulator(key: string) {
  return {
    key,
    sessionIds: new Set<string>(),
    userMessages: 0,
    assistantMessages: 0,
    assistantTurns: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
}

function toDeepMetricRow(acc: ReturnType<typeof createDeepMetricAccumulator>): DeepAnalyticsMetricRow {
  const avgDurationMs = acc.assistantTurns > 0 ? Math.round(acc.totalDurationMs / acc.assistantTurns) : 0;
  return {
    key: acc.key,
    sessions: acc.sessionIds.size,
    userMessages: acc.userMessages,
    assistantMessages: acc.assistantMessages,
    assistantTurns: acc.assistantTurns,
    toolCalls: acc.toolCalls,
    totalDurationMs: acc.totalDurationMs,
    avgDurationMs,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.totalTokens,
    cost: acc.cost,
  };
}

function createDeepBucket(start: number, end: number): DeepAnalyticsBucket {
  return {
    start,
    end,
    sessionsStarted: 0,
    userMessages: 0,
    assistantMessages: 0,
    assistantTurns: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    touches: 0,
  };
}

function clampBucketMs(raw?: number): number {
  const allowed = [
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000,
    2 * 60 * 60_000,
    6 * 60 * 60_000,
    12 * 60 * 60_000,
    24 * 60 * 60_000,
  ];
  if (!raw || !Number.isFinite(raw)) return 60 * 60_000;
  return allowed.reduce((best, next) =>
    Math.abs(next - raw) < Math.abs(best - raw) ? next : best,
  );
}

function bucketIndex(ts: number, start: number, bucketMs: number, bucketCount: number): number | null {
  if (ts < start) return null;
  const idx = Math.floor((ts - start) / bucketMs);
  if (idx < 0 || idx >= bucketCount) return null;
  return idx;
}

function countAssistantToolUses(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) return 0;
    let count = 0;
    for (const block of content) {
      if (block?.type === "tool_use") count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function parseResultUsage(raw: string): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, any>;
    let cacheRead = 0;
    let cacheWrite = 0;
    if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
      for (const model of Object.values(parsed.modelUsage as Record<string, any>)) {
        cacheRead += model?.cacheReadInputTokens ?? 0;
        cacheWrite += model?.cacheCreationInputTokens ?? 0;
      }
    }
    const rawInput = typeof parsed.input_tokens === "number" ? parsed.input_tokens : 0;
    const outputTokens = typeof parsed.output_tokens === "number" ? parsed.output_tokens : 0;
    const inputTokens = rawInput + cacheRead + cacheWrite;
    const totalTokens = inputTokens + outputTokens;
    const cost = typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : 0;
    const durationMs = typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0;
    return { inputTokens, outputTokens, totalTokens, cost, durationMs };
  } catch {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, durationMs: 0 };
  }
}

export function getDeepAnalytics(
  opts: { userProfile?: string; cwd?: string; provider?: string; start?: number; end?: number; bucketMs?: number } = {},
): DeepAnalytics {
  const end = Number.isFinite(opts.end) ? Math.max(0, Math.floor(opts.end!)) : Date.now();
  const start = Number.isFinite(opts.start)
    ? Math.max(0, Math.floor(opts.start!))
    : end - 48 * 60 * 60_000;
  const safeStart = Math.min(start, end);
  const safeEnd = Math.max(start, end);
  const bucketMs = clampBucketMs(opts.bucketMs);
  const bucketCount = Math.max(1, Math.min(512, Math.ceil((safeEnd - safeStart || bucketMs) / bucketMs)));
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = safeStart + index * bucketMs;
    return createDeepBucket(bucketStart, Math.min(safeEnd, bucketStart + bucketMs));
  });

  const base = `s.tags NOT LIKE '%"archived"%' AND s.tags NOT LIKE '%"internal"%'`;
  const filters: string[] = [];
  const params: any[] = [];
  if (opts.userProfile) {
    filters.push(`(s.user_profile = ? OR s.user_profile IS NULL)`);
    params.push(opts.userProfile);
  }
  if (opts.cwd) {
    filters.push(`s.cwd LIKE ? ESCAPE '\\'`);
    params.push(opts.cwd.replace(/[%_]/g, "\\$&") + "%");
  }
  if (opts.provider) {
    filters.push(`COALESCE(s.provider, '(unknown)') = ?`);
    params.push(opts.provider);
  }
  const where = filters.length > 0 ? ` AND ${filters.join(" AND ")}` : "";

  const totals = {
    sessionsStarted: 0,
    sessionsActive: 0,
    userMessages: 0,
    assistantMessages: 0,
    assistantTurns: 0,
    toolCalls: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
  };

  const providerAgg = new Map<string, ReturnType<typeof createDeepMetricAccumulator>>();
  const modelAgg = new Map<string, ReturnType<typeof createDeepMetricAccumulator>>();
  const profileAgg = new Map<string, ReturnType<typeof createDeepMetricAccumulator>>();
  const projectAgg = new Map<string, ReturnType<typeof createDeepMetricAccumulator>>();
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    userMessages: 0,
    assistantTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
  }));

  const sessions = new Map<string, DeepAnalyticsSessionRow>();

  const ensureSession = (row: {
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }) => {
    let session = sessions.get(row.id);
    if (!session) {
      session = {
        id: row.id,
        preview: row.preview,
        profile: row.profile,
        provider: row.provider,
        model: row.model,
        cwd: row.cwd,
        createdAt: row.created_at,
        lastMessageAt: row.last_message_at,
        totalMessages: row.message_count,
        totalCost: row.total_cost_usd,
        userMessages: 0,
        assistantMessages: 0,
        assistantTurns: 0,
        toolCalls: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      };
      sessions.set(row.id, session);
    }
    return session;
  };

  const ensureMetric = (
    map: Map<string, ReturnType<typeof createDeepMetricAccumulator>>,
    key: string,
  ) => {
    let acc = map.get(key);
    if (!acc) {
      acc = createDeepMetricAccumulator(key);
      map.set(key, acc);
    }
    return acc;
  };

  const addMetricSession = (row: DeepAnalyticsSessionRow) => {
    ensureMetric(providerAgg, row.provider || "(unknown)").sessionIds.add(row.id);
    ensureMetric(modelAgg, row.model || "(unknown)").sessionIds.add(row.id);
    ensureMetric(profileAgg, row.profile || "(default)").sessionIds.add(row.id);
    ensureMetric(projectAgg, row.cwd || "(none)").sessionIds.add(row.id);
  };

  const overlappingSessions = db.prepare(`
    SELECT
      s.id,
      s.preview,
      s.profile,
      s.provider,
      s.model,
      s.cwd,
      s.created_at,
      COALESCE(s.last_message_at, s.updated_at, s.created_at) AS last_message_at,
      s.message_count,
      s.total_cost_usd
    FROM sessions s
    WHERE ${base}
      ${where}
      AND s.created_at <= ?
      AND COALESCE(s.last_message_at, s.updated_at, s.created_at) >= ?
    ORDER BY COALESCE(s.last_message_at, s.updated_at, s.created_at) DESC
  `).all(...params, safeEnd, safeStart) as Array<{
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }>;

  for (const row of overlappingSessions) {
    addMetricSession(ensureSession(row));
  }
  totals.sessionsActive = sessions.size;

  const startedSessions = db.prepare(`
    SELECT
      s.id,
      s.preview,
      s.profile,
      s.provider,
      s.model,
      s.cwd,
      s.created_at,
      COALESCE(s.last_message_at, s.updated_at, s.created_at) AS last_message_at,
      s.message_count,
      s.total_cost_usd
    FROM sessions s
    WHERE ${base}
      ${where}
      AND s.created_at >= ?
      AND s.created_at <= ?
  `).all(...params, safeStart, safeEnd) as Array<{
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }>;

  for (const row of startedSessions) {
    const session = ensureSession(row);
    addMetricSession(session);
    totals.sessionsStarted += 1;
    const idx = bucketIndex(row.created_at, safeStart, bucketMs, bucketCount);
    if (idx != null) buckets[idx]!.sessionsStarted += 1;
  }

  const userPromptRows = db.prepare(`
    SELECT
      e.session_id,
      e.created_at,
      s.id,
      s.preview,
      s.profile,
      s.provider,
      s.model,
      s.cwd,
      s.created_at AS session_created_at,
      COALESCE(s.last_message_at, s.updated_at, s.created_at) AS last_message_at,
      s.message_count,
      s.total_cost_usd
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    WHERE ${base}
      ${where}
      AND e.type = 'user'
      AND (e.subtype = 'prompt' OR e.data LIKE '%\"subtype\":\"prompt\"%')
      AND e.created_at >= ?
      AND e.created_at <= ?
    ORDER BY e.created_at ASC
  `).all(...params, safeStart, safeEnd) as Array<{
    session_id: string;
    created_at: number;
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    session_created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }>;

  for (const row of userPromptRows) {
    const session = ensureSession({
      id: row.id,
      preview: row.preview,
      profile: row.profile,
      provider: row.provider,
      model: row.model,
      cwd: row.cwd,
      created_at: row.session_created_at,
      last_message_at: row.last_message_at,
      message_count: row.message_count,
      total_cost_usd: row.total_cost_usd,
    });
    addMetricSession(session);
    const metrics = [
      ensureMetric(providerAgg, session.provider || "(unknown)"),
      ensureMetric(modelAgg, session.model || "(unknown)"),
      ensureMetric(profileAgg, session.profile || "(default)"),
      ensureMetric(projectAgg, session.cwd || "(none)"),
    ];
    const idx = bucketIndex(row.created_at, safeStart, bucketMs, bucketCount);
    const hour = new Date(row.created_at).getHours();
    totals.userMessages += 1;
    session.userMessages += 1;
    for (const metric of metrics) metric.userMessages += 1;
    if (idx != null) buckets[idx]!.userMessages += 1;
    hours[hour]!.userMessages += 1;
  }

  const resultRows = db.prepare(`
    SELECT
      e.session_id,
      e.data,
      e.created_at,
      s.id,
      s.preview,
      s.profile,
      s.provider,
      s.model,
      s.cwd,
      s.created_at AS session_created_at,
      COALESCE(s.last_message_at, s.updated_at, s.created_at) AS last_message_at,
      s.message_count,
      s.total_cost_usd
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.type = 'result'
      AND ${base}
      ${where}
      AND e.created_at >= ?
      AND e.created_at <= ?
    ORDER BY e.created_at ASC
  `).all(...params, safeStart, safeEnd) as Array<{
    session_id: string;
    data: string;
    created_at: number;
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    session_created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }>;

  for (const row of resultRows) {
    const session = ensureSession({
      id: row.id,
      preview: row.preview,
      profile: row.profile,
      provider: row.provider,
      model: row.model,
      cwd: row.cwd,
      created_at: row.session_created_at,
      last_message_at: row.last_message_at,
      message_count: row.message_count,
      total_cost_usd: row.total_cost_usd,
    });
    addMetricSession(session);
    const metrics = [
      ensureMetric(providerAgg, session.provider || "(unknown)"),
      ensureMetric(modelAgg, session.model || "(unknown)"),
      ensureMetric(profileAgg, session.profile || "(default)"),
      ensureMetric(projectAgg, session.cwd || "(none)"),
    ];
    const usage = parseResultUsage(row.data);
    const idx = bucketIndex(row.created_at, safeStart, bucketMs, bucketCount);
    const hour = new Date(row.created_at).getHours();

    totals.assistantTurns += 1;
    totals.assistantMessages += 1;
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.totalTokens += usage.totalTokens;
    totals.cost += usage.cost;
    totals.totalDurationMs += usage.durationMs;

    session.assistantMessages += 1;
    session.assistantTurns += 1;
    session.totalDurationMs += usage.durationMs;
    session.inputTokens += usage.inputTokens;
    session.outputTokens += usage.outputTokens;
    session.totalTokens += usage.totalTokens;

    for (const metric of metrics) {
      metric.assistantMessages += 1;
      metric.assistantTurns += 1;
      metric.totalDurationMs += usage.durationMs;
      metric.inputTokens += usage.inputTokens;
      metric.outputTokens += usage.outputTokens;
      metric.totalTokens += usage.totalTokens;
      metric.cost += usage.cost;
    }

    if (idx != null) {
      buckets[idx]!.assistantMessages += 1;
      buckets[idx]!.assistantTurns += 1;
      buckets[idx]!.totalDurationMs += usage.durationMs;
      buckets[idx]!.inputTokens += usage.inputTokens;
      buckets[idx]!.outputTokens += usage.outputTokens;
      buckets[idx]!.totalTokens += usage.totalTokens;
      buckets[idx]!.cost += usage.cost;
    }

    hours[hour]!.assistantTurns += 1;
    hours[hour]!.inputTokens += usage.inputTokens;
    hours[hour]!.outputTokens += usage.outputTokens;
    hours[hour]!.totalTokens += usage.totalTokens;
    hours[hour]!.cost += usage.cost;
  }

  const assistantRows = db.prepare(`
    SELECT
      e.session_id,
      e.data,
      e.created_at,
      s.id,
      s.preview,
      s.profile,
      s.provider,
      s.model,
      s.cwd,
      s.created_at AS session_created_at,
      COALESCE(s.last_message_at, s.updated_at, s.created_at) AS last_message_at,
      s.message_count,
      s.total_cost_usd
    FROM events e
    JOIN sessions s ON s.id = e.session_id
    WHERE e.type = 'assistant'
      AND ${base}
      ${where}
      AND e.created_at >= ?
      AND e.created_at <= ?
    ORDER BY e.created_at ASC
  `).all(...params, safeStart, safeEnd) as Array<{
    session_id: string;
    data: string;
    created_at: number;
    id: string;
    preview: string;
    profile: string | null;
    provider: string | null;
    model: string | null;
    cwd: string | null;
    session_created_at: number;
    last_message_at: number;
    message_count: number;
    total_cost_usd: number;
  }>;

  for (const row of assistantRows) {
    const toolCalls = countAssistantToolUses(row.data);
    if (toolCalls <= 0) continue;

    const session = ensureSession({
      id: row.id,
      preview: row.preview,
      profile: row.profile,
      provider: row.provider,
      model: row.model,
      cwd: row.cwd,
      created_at: row.session_created_at,
      last_message_at: row.last_message_at,
      message_count: row.message_count,
      total_cost_usd: row.total_cost_usd,
    });
    addMetricSession(session);
    const metrics = [
      ensureMetric(providerAgg, session.provider || "(unknown)"),
      ensureMetric(modelAgg, session.model || "(unknown)"),
      ensureMetric(profileAgg, session.profile || "(default)"),
      ensureMetric(projectAgg, session.cwd || "(none)"),
    ];
    const idx = bucketIndex(row.created_at, safeStart, bucketMs, bucketCount);
    const hour = new Date(row.created_at).getHours();

    totals.toolCalls += toolCalls;
    session.toolCalls += toolCalls;
    for (const metric of metrics) metric.toolCalls += toolCalls;
    if (idx != null) buckets[idx]!.toolCalls += toolCalls;
    hours[hour]!.toolCalls += toolCalls;
  }

  totals.avgDurationMs = totals.assistantTurns > 0
    ? Math.round(totals.totalDurationMs / totals.assistantTurns)
    : 0;

  return {
    range: {
      start: safeStart,
      end: safeEnd,
      bucketMs,
      bucketCount,
    },
    totals,
    buckets,
    byProvider: [...providerAgg.values()].map(toDeepMetricRow).sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost),
    byModel: [...modelAgg.values()].map(toDeepMetricRow).sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost),
    byProfile: [...profileAgg.values()].map(toDeepMetricRow).sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost),
    byProject: [...projectAgg.values()].map(toDeepMetricRow).sort((a, b) => b.totalTokens - a.totalTokens || b.cost - a.cost),
    byHour: hours,
    sessions: [...sessions.values()]
      .map((row) => ({
        ...row,
        avgDurationMs: row.assistantTurns > 0 ? Math.round(row.totalDurationMs / row.assistantTurns) : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens || b.toolCalls - a.toolCalls || b.lastMessageAt - a.lastMessageAt),
  };
}

// ── Startup Cleanup ──
// Mark orphaned running/starting/interrupting/idle/error sessions as done
// (harness restarted while they were active)
// Wrapped in try/catch: on Windows, a ghost process may still hold the DB write lock.
// Database modules are also imported by tests while a real Modus backend may be
// using the same workspace DB. Test workers must never mutate that live state.
const runStartupMaintenance = process.env.NODE_ENV !== "test"
  && process.env.MODUS_SKIP_STARTUP_MAINTENANCE !== "1";
if (runStartupMaintenance) {
try {
  // Inject a terminal `system/interrupted` event for any orphaned session whose
  // event log doesn't already end in a terminal event. Without this, the UI
  // subscribes, sees an in-progress assistant turn with no closer, and freezes
  // waiting on SSE for a stream that will never come ("poisoned" sessions).
  const orphanedSessions = db.query<{ id: string }, []>(
    `SELECT id FROM sessions WHERE status IN ('running', 'starting', 'interrupting', 'idle', 'paused')`
  ).all();
  let injected = 0;
  for (const { id } of orphanedSessions) {
    const last = db.query<{ type: string; subtype: string | null; seq: number }, [string]>(
      `SELECT type, subtype, seq FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT 1`
    ).get(id);
    if (!last) continue;
    const isTerminal =
      last.type === "result" ||
      last.type === "error" ||
      (last.type === "system" && last.subtype === "interrupted");
    if (isTerminal) continue;
    const nextSeq = last.seq + 1;
    const payload = JSON.stringify({
      type: "system",
      subtype: "interrupted",
      reason: "harness restarted while session was active",
    });
    db.run(
      `INSERT INTO events (session_id, seq, type, subtype, data, created_at) VALUES (?, ?, 'system', 'interrupted', ?, ?)`,
      [id, nextSeq, payload, Date.now()]
    );
    injected++;
  }
  if (injected > 0) {
    console.log(`[db] Injected synthetic interrupted event for ${injected} orphaned session(s)`);
  }
  db.run(`UPDATE sessions SET status = 'done' WHERE status IN ('running', 'starting', 'interrupting', 'idle', 'error')`);
  // Mark orphaned action runs as error (harness crashed mid-run)
  const staleRuns = db.run(`UPDATE action_runs SET status = 'error', error = 'harness crashed during run', completed_at = ${Date.now()} WHERE status = 'running'`);
  if (staleRuns.changes > 0) {
    console.log(`[db] Cleaned up ${staleRuns.changes} orphaned action run(s) from previous crash`);
  }
  // Mark orphaned executions as done (harness crashed mid-execution)
  const staleExecs = db.run(`UPDATE action_executions SET status = 'done', completed_at = ${Date.now()} WHERE status = 'running'`);
  if (staleExecs.changes > 0) {
    console.log(`[db] Cleaned up ${staleExecs.changes} orphaned execution(s) from previous crash`);
  }
} catch (e) {
  console.warn(`[db] Startup cleanup skipped (db may be locked by another process): ${e}`);
}
}

// Prune stream events from all unpruned completed sessions
if (runStartupMaintenance) pruneAllSessionEvents();

export { db };
