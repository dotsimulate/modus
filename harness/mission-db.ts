/**
 * Mission DB — persisted execution state for missions.
 *
 * Uses the existing harness.db via the shared db module.
 * Tables: mission_runs, mission_step_runs, mission_assignments,
 *         mission_transfers, mission_gate_results.
 *
 * On import: runs stale-run repair — any runs left "running" or "pending"
 * from a previous harness crash get marked as error with RUNNER_ERROR,
 * mirroring the action repair pattern.
 */

import { db } from "./db";
import type {
  MissionRunRow, MissionStepRunRow, MissionAssignmentRow,
  MissionTransferRow, MissionGateResultRow,
  MissionRunStatus, MissionStepStatus, MissionAssignmentStatus,
  MissionHaltKind, MissionTransferKind, MissionGateType,
} from "./mission-types";

// ── Schema ──

db.run(`
  CREATE TABLE IF NOT EXISTS mission_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_name TEXT NOT NULL,
    cwd TEXT NOT NULL,
    user_profile TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    current_step_index INTEGER NOT NULL DEFAULT 0,
    orchestrator_session_id TEXT,
    definition_snapshot TEXT NOT NULL,
    halt_kind TEXT,
    halt_message TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )
`);
// Add current_cycle column if missing (migration for existing DBs)
try { db.run(`ALTER TABLE mission_runs ADD COLUMN current_cycle INTEGER NOT NULL DEFAULT 1`); } catch { /* column already exists */ }
try { db.run(`ALTER TABLE mission_runs ADD COLUMN warning TEXT`); } catch { /* column already exists */ }

db.run(`CREATE INDEX IF NOT EXISTS idx_mission_runs_name ON mission_runs(mission_name, started_at DESC)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_runs_status ON mission_runs(status)`);

db.run(`
  CREATE TABLE IF NOT EXISTS mission_step_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES mission_runs(id),
    step_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    role TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    active_assignment_id INTEGER,
    started_at INTEGER,
    completed_at INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_steps_run ON mission_step_runs(run_id, step_order)`);

db.run(`
  CREATE TABLE IF NOT EXISTS mission_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES mission_runs(id),
    step_id TEXT NOT NULL,
    role TEXT NOT NULL,
    session_id TEXT,
    source_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    brief TEXT,
    result_summary TEXT,
    failure_kind TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_assign_run ON mission_assignments(run_id, step_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_assign_session ON mission_assignments(session_id)`);

db.run(`
  CREATE TABLE IF NOT EXISTS mission_transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES mission_runs(id),
    step_id TEXT NOT NULL,
    from_session_id TEXT,
    to_session_id TEXT,
    kind TEXT NOT NULL,
    summary TEXT,
    details TEXT,
    created_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_transfer_run ON mission_transfers(run_id, step_id)`);

db.run(`
  CREATE TABLE IF NOT EXISTS mission_gate_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL REFERENCES mission_runs(id),
    step_id TEXT NOT NULL,
    assignment_id INTEGER,
    gate_type TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT,
    checked_at INTEGER NOT NULL
  )
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_mission_gates_run ON mission_gate_results(run_id, step_id)`);

// ── Stale-Run Repair ──
// Runs left running/pending from a previous harness process become paused/RUNNER_RESTARTED.
// Active assignments are failed (sessions are gone), but the run itself is resumable.

const now = Date.now();
db.run(`
  UPDATE mission_runs
  SET status = 'paused', halt_kind = 'RUNNER_RESTARTED', halt_message = 'Harness restarted — resume to continue from current step', updated_at = ?
  WHERE status IN ('running', 'pending')
`, [now]);
db.run(`
  UPDATE mission_assignments
  SET status = 'failed', failure_kind = 'RUNNER_RESTARTED', completed_at = ?
  WHERE status = 'active'
`, [now]);

// ── Prepared Statements ──

const stmts = {
  // Runs
  insertRun: db.prepare(`
    INSERT INTO mission_runs (mission_name, cwd, user_profile, status, current_step_index, orchestrator_session_id, definition_snapshot, started_at, updated_at)
    VALUES ($mission_name, $cwd, $user_profile, $status, $current_step_index, $orchestrator_session_id, $definition_snapshot, $started_at, $updated_at)
  `),
  getRun: db.prepare(`SELECT * FROM mission_runs WHERE id = $id`),
  listRuns: db.prepare(`
    SELECT * FROM mission_runs
    WHERE ($cwd IS NULL OR cwd = $cwd) AND ($status IS NULL OR status = $status)
    ORDER BY started_at DESC LIMIT $limit
  `),
  updateRun: db.prepare(`
    UPDATE mission_runs SET
      status = COALESCE($status, status),
      current_step_index = COALESCE($current_step_index, current_step_index),
      current_cycle = COALESCE($current_cycle, current_cycle),
      orchestrator_session_id = COALESCE($orchestrator_session_id, orchestrator_session_id),
      halt_kind = $halt_kind,
      halt_message = $halt_message,
      warning = COALESCE($warning, warning),
      updated_at = $updated_at,
      completed_at = $completed_at
    WHERE id = $id
  `),

  // Steps
  insertStep: db.prepare(`
    INSERT INTO mission_step_runs (run_id, step_id, step_order, role, title, status)
    VALUES ($run_id, $step_id, $step_order, $role, $title, $status)
  `),
  getSteps: db.prepare(`
    SELECT * FROM mission_step_runs WHERE run_id = $run_id ORDER BY step_order ASC
  `),
  getStep: db.prepare(`
    SELECT * FROM mission_step_runs WHERE run_id = $run_id AND step_id = $step_id
  `),
  updateStep: db.prepare(`
    UPDATE mission_step_runs SET
      status = COALESCE($status, status),
      active_assignment_id = $active_assignment_id,
      started_at = COALESCE($started_at, started_at),
      completed_at = $completed_at
    WHERE id = $id
  `),

  // Assignments
  insertAssignment: db.prepare(`
    INSERT INTO mission_assignments (run_id, step_id, role, session_id, source_session_id, status, brief, started_at)
    VALUES ($run_id, $step_id, $role, $session_id, $source_session_id, $status, $brief, $started_at)
  `),
  getAssignments: db.prepare(`
    SELECT * FROM mission_assignments WHERE run_id = $run_id ORDER BY started_at DESC
  `),
  getAssignment: db.prepare(`
    SELECT * FROM mission_assignments WHERE id = $id
  `),
  updateAssignment: db.prepare(`
    UPDATE mission_assignments SET
      status = COALESCE($status, status),
      session_id = COALESCE($session_id, session_id),
      result_summary = COALESCE($result_summary, result_summary),
      failure_kind = $failure_kind,
      completed_at = $completed_at
    WHERE id = $id
  `),

  // Transfers
  insertTransfer: db.prepare(`
    INSERT INTO mission_transfers (run_id, step_id, from_session_id, to_session_id, kind, summary, details, created_at)
    VALUES ($run_id, $step_id, $from_session_id, $to_session_id, $kind, $summary, $details, $created_at)
  `),
  getTransfers: db.prepare(`
    SELECT * FROM mission_transfers WHERE run_id = $run_id ORDER BY created_at DESC
  `),

  // Gates
  insertGate: db.prepare(`
    INSERT INTO mission_gate_results (run_id, step_id, assignment_id, gate_type, status, evidence, checked_at)
    VALUES ($run_id, $step_id, $assignment_id, $gate_type, $status, $evidence, $checked_at)
  `),
  getGates: db.prepare(`
    SELECT * FROM mission_gate_results WHERE run_id = $run_id ORDER BY checked_at DESC
  `),
  getStepGates: db.prepare(`
    SELECT * FROM mission_gate_results WHERE run_id = $run_id AND step_id = $step_id ORDER BY checked_at DESC
  `),
  deleteRunGates: db.prepare(`
    DELETE FROM mission_gate_results WHERE run_id = $run_id
  `),
  resetSteps: db.prepare(`
    UPDATE mission_step_runs SET status = 'pending', active_assignment_id = NULL, started_at = NULL, completed_at = NULL
    WHERE run_id = $run_id
  `),

  // Mission-specific run number (1-based ordinal for a given mission name)
  getRunNumber: db.prepare(`
    SELECT COUNT(*) as n FROM mission_runs WHERE mission_name = $mission_name AND id <= $id
  `),

  // Session lookup (for GET /api/missions/runs/:id/sessions)
  getRunSessions: db.prepare(`
    SELECT DISTINCT session_id FROM mission_assignments WHERE run_id = $run_id AND session_id IS NOT NULL
    UNION
    SELECT orchestrator_session_id FROM mission_runs WHERE id = $run_id AND orchestrator_session_id IS NOT NULL
  `),

  // Dead worker detection: find active assignments for a given session
  getActiveAssignmentsBySession: db.prepare(`
    SELECT * FROM mission_assignments
    WHERE session_id = $session_id AND status = 'active'
  `),
};

// ── Helper ──

function lastInsertId(): number {
  return Number((db.query("SELECT last_insert_rowid() as id").get() as any).id);
}

// ── Run CRUD ──

export function insertMissionRun(opts: {
  missionName: string;
  cwd: string;
  userProfile?: string;
  definitionSnapshot: string;
  orchestratorSessionId?: string;
}): number {
  const now = Date.now();
  stmts.insertRun.run({
    $mission_name: opts.missionName,
    $cwd: opts.cwd,
    $user_profile: opts.userProfile ?? null,
    $status: "pending",
    $current_step_index: 0,
    $orchestrator_session_id: opts.orchestratorSessionId ?? null,
    $definition_snapshot: opts.definitionSnapshot,
    $started_at: now,
    $updated_at: now,
  });
  return lastInsertId();
}

export function getMissionRun(id: number): MissionRunRow | null {
  return (stmts.getRun.get({ $id: id }) as MissionRunRow) ?? null;
}

/** 1-based run number scoped to a specific mission name (not the global row ID). */
export function getMissionRunNumber(missionName: string, runId: number): number {
  const row = stmts.getRunNumber.get({ $mission_name: missionName, $id: runId }) as { n: number } | null;
  return row?.n ?? 1;
}

export function listMissionRuns(opts?: {
  cwd?: string;
  status?: string;
  limit?: number;
}): MissionRunRow[] {
  return stmts.listRuns.all({
    $cwd: opts?.cwd ?? null,
    $status: opts?.status ?? null,
    $limit: opts?.limit ?? 50,
  }) as MissionRunRow[];
}

export function updateMissionRun(id: number, updates: {
  status?: MissionRunStatus;
  currentStepIndex?: number;
  currentCycle?: number;
  orchestratorSessionId?: string;
  haltKind?: MissionHaltKind | null;
  haltMessage?: string | null;
  warning?: string;
  completedAt?: number | null;
}): void {
  stmts.updateRun.run({
    $id: id,
    $status: updates.status ?? null,
    $current_step_index: updates.currentStepIndex ?? null,
    $current_cycle: updates.currentCycle ?? null,
    $orchestrator_session_id: updates.orchestratorSessionId ?? null,
    $halt_kind: updates.haltKind ?? null,
    $halt_message: updates.haltMessage ?? null,
    $warning: updates.warning ?? null,
    $updated_at: Date.now(),
    $completed_at: updates.completedAt ?? null,
  });
}

// ── Step CRUD ──

export function insertMissionStep(opts: {
  runId: number;
  stepId: string;
  stepOrder: number;
  role: string;
  title: string;
}): number {
  stmts.insertStep.run({
    $run_id: opts.runId,
    $step_id: opts.stepId,
    $step_order: opts.stepOrder,
    $role: opts.role,
    $title: opts.title,
    $status: "pending",
  });
  return lastInsertId();
}

export function getMissionSteps(runId: number): MissionStepRunRow[] {
  return stmts.getSteps.all({ $run_id: runId }) as MissionStepRunRow[];
}

export function getMissionStep(runId: number, stepId: string): MissionStepRunRow | null {
  return (stmts.getStep.get({ $run_id: runId, $step_id: stepId }) as MissionStepRunRow) ?? null;
}

export function updateMissionStep(id: number, updates: {
  status?: MissionStepStatus;
  activeAssignmentId?: number | null;
  startedAt?: number | null;
  completedAt?: number | null;
}): void {
  stmts.updateStep.run({
    $id: id,
    $status: updates.status ?? null,
    $active_assignment_id: updates.activeAssignmentId ?? null,
    $started_at: updates.startedAt ?? null,
    $completed_at: updates.completedAt ?? null,
  });
}

// ── Assignment CRUD ──

export function insertMissionAssignment(opts: {
  runId: number;
  stepId: string;
  role: string;
  sessionId?: string;
  sourceSessionId?: string;
  brief?: string;
}): number {
  stmts.insertAssignment.run({
    $run_id: opts.runId,
    $step_id: opts.stepId,
    $role: opts.role,
    $session_id: opts.sessionId ?? null,
    $source_session_id: opts.sourceSessionId ?? null,
    $status: "active",
    $brief: opts.brief ?? null,
    $started_at: Date.now(),
  });
  return lastInsertId();
}

export function getMissionAssignments(runId: number): MissionAssignmentRow[] {
  return stmts.getAssignments.all({ $run_id: runId }) as MissionAssignmentRow[];
}

export function getMissionAssignment(id: number): MissionAssignmentRow | null {
  return (stmts.getAssignment.get({ $id: id }) as MissionAssignmentRow) ?? null;
}

export function updateMissionAssignment(id: number, updates: {
  status?: MissionAssignmentStatus;
  sessionId?: string;
  resultSummary?: string;
  failureKind?: MissionHaltKind | null;
  completedAt?: number | null;
}): void {
  stmts.updateAssignment.run({
    $id: id,
    $status: updates.status ?? null,
    $session_id: updates.sessionId ?? null,
    $result_summary: updates.resultSummary ?? null,
    $failure_kind: updates.failureKind ?? null,
    $completed_at: updates.completedAt ?? null,
  });
}

// ── Transfer CRUD ──

export function insertMissionTransfer(opts: {
  runId: number;
  stepId: string;
  fromSessionId?: string;
  toSessionId?: string;
  kind: MissionTransferKind;
  summary?: string;
  details?: string;
}): number {
  stmts.insertTransfer.run({
    $run_id: opts.runId,
    $step_id: opts.stepId,
    $from_session_id: opts.fromSessionId ?? null,
    $to_session_id: opts.toSessionId ?? null,
    $kind: opts.kind,
    $summary: opts.summary ?? null,
    $details: opts.details ?? null,
    $created_at: Date.now(),
  });
  return lastInsertId();
}

export function getMissionTransfers(runId: number): MissionTransferRow[] {
  return stmts.getTransfers.all({ $run_id: runId }) as MissionTransferRow[];
}

// ── Gate CRUD ──

export function insertMissionGateResult(opts: {
  runId: number;
  stepId: string;
  assignmentId?: number;
  gateType: MissionGateType;
  status: "pass" | "fail";
  evidence?: string;
}): number {
  stmts.insertGate.run({
    $run_id: opts.runId,
    $step_id: opts.stepId,
    $assignment_id: opts.assignmentId ?? null,
    $gate_type: opts.gateType,
    $status: opts.status,
    $evidence: opts.evidence ?? null,
    $checked_at: Date.now(),
  });
  return lastInsertId();
}

export function getMissionGateResults(runId: number): MissionGateResultRow[] {
  return stmts.getGates.all({ $run_id: runId }) as MissionGateResultRow[];
}

export function getStepGateResults(runId: number, stepId: string): MissionGateResultRow[] {
  return stmts.getStepGates.all({ $run_id: runId, $step_id: stepId }) as MissionGateResultRow[];
}

/** Clear all gate results for a run (used on cycle reset). */
export function clearMissionGates(runId: number): void {
  stmts.deleteRunGates.run({ $run_id: runId });
}

/** Reset all steps to pending with cleared timestamps (used on cycle reset). */
export function resetMissionSteps(runId: number): void {
  stmts.resetSteps.run({ $run_id: runId });
}

// ── Dead Worker Detection ──

export function getActiveAssignmentsBySessionId(sessionId: string): MissionAssignmentRow[] {
  return stmts.getActiveAssignmentsBySession.all({ $session_id: sessionId }) as MissionAssignmentRow[];
}

// ── Session Lookup ──

export function getMissionRunSessionIds(runId: number): string[] {
  const rows = stmts.getRunSessions.all({ $run_id: runId }) as Array<{ session_id?: string; orchestrator_session_id?: string }>;
  return rows.map(r => r.session_id ?? r.orchestrator_session_id).filter((s): s is string => !!s);
}
