/**
 * Mission Types — shared contracts for the mission orchestration system.
 *
 * Missions are the project-level orchestration primitive:
 *   - Prompts inject guidance
 *   - Moves are structured interactions
 *   - Actions are automated triggers
 *   - Missions coordinate multi-agent workflows over time
 *
 * Authored definitions live in `.modus/missions/<name>/mission.json`.
 * Runtime state lives in harness.db (mission_runs, mission_step_runs, etc.).
 * The model interacts through a scoped command bus via modus_submit.
 */

// ── Authored Definition (mission.json) ──

export interface MissionConfig {
  name: string;
  label: string;
  description: string;
  enabled?: boolean;
  /** Optional path to a markdown brief file, resolved relative to the mission directory. */
  brief?: string;
  /** Resolved brief markdown captured into the run snapshot at mission start. */
  resolvedBrief?: string;

  /** Role-to-profile mapping. Keys are role names, values are agent profile names. */
  roles: Record<string, MissionRoleConfig>;

  /** Ordered step definitions. Structure is frozen at run start. */
  steps: MissionStepDefinition[];

  /** Cycling configuration — when enabled, all steps reset after completion and the mission continues. */
  cycle?: {
    enabled?: boolean;
    maxCycles?: number | null;
    /** When true, the orchestrator gets a fresh session each cycle instead of continuing
     *  in the same (potentially degraded) context. Enables the bootstrap pattern where
     *  agents re-read curated memory files from a clean state each cycle. Default: false. */
    freshOrchestrator?: boolean;
    budget?: { usd?: number | null };
  };

  /** Execution policy */
  policy: MissionPolicy;

  /** Budget constraints */
  budgets?: {
    usd?: number;
    hours?: number;
    turnsPerSession?: number;
  };

  /** Failure handling */
  onFailure?: {
    strategy: "pause" | "stop";
    maxRetriesPerStep?: number;
  };

  /** Page declaration — registers a page in the nav for this mission */
  page?: MissionPageDeclaration;

  tags?: string[];
}

/** Declared in mission.json — registers a page in the nav for this mission */
export interface MissionPageDeclaration {
  /** Page ID used in URL hash (e.g. #page:mission-dash) */
  id: string;
  /** Display title in the nav bar */
  title: string;
  /** Optional icon for the nav link */
  icon?: string;
  /** Show in the main nav bar. Default true. */
  nav?: boolean;
  /** Full layout tree (same schema as .modus/pages/*.json). */
  layout?: unknown;
  /** Optional breakpoint-specific layout trees. */
  layouts?: {
    mobile?: unknown;
  };
  /** Initial page-scoped shared state for widget linking (pub/sub). */
  context?: Record<string, unknown>;
  /** Outer padding in pixels around the layout container. */
  padding?: number;
}

export interface MissionRoleConfig {
  /** Agent profile name to use for this role */
  profile: string;
  /** Optional description of what this role does */
  description?: string;
}

export interface MissionPolicy {
  requireTestsBeforeAdvance?: boolean;
  requireCommitBeforeAdvance?: boolean;
  requireHandoffOnTransfer?: boolean;
  /** V1: always false. Single active step only. */
  allowParallelSteps?: boolean;
  maxConcurrentAgents?: number;
}

// ── Step & Gate Definitions ──

export interface MissionStepDefinition {
  id: string;
  label: string;
  /** Role that owns this step */
  role: string;
  /** Optional reviewer role */
  reviewer?: string;
  /** Gates required before this step can complete */
  gates: MissionGateDefinition[];
  /** Optional authored description / brief for the step */
  description?: string;
}

export interface MissionGateDefinition {
  type: MissionGateType;
  required?: boolean; // default true
}

export type MissionGateType = "handoff" | "tests" | "commit" | "review";

// ── Runtime Status Types ──

export type MissionRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "error"
  | "paused";

export type MissionStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type MissionHaltKind =
  | "RUNNER_ERROR"
  | "RUNNER_RESTARTED"
  | "GATE_FAILURE"
  | "AGENT_FAILURE"
  | "WORKER_DIED"
  | "MISSION_PAUSED";

export type MissionAssignmentStatus =
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

export type MissionTransferKind =
  | "delegation"
  | "report"
  | "review"
  | "escalation";

// ── Mission Tool Grants ──

/** Determines what ops a session can use through the mission command bus. */
export interface MissionToolGrant {
  token: string;
  runId: number;
  role: string;
  sessionId: string;
  /** Which ops this grant allows */
  allowedOps: MissionOp[];
  createdAt: number;
}

/** Operations available through the mission command bus (modus_submit with mission token). */
export type MissionOp =
  | "read"
  | "delegate"
  | "report"
  | "gate"
  | "advance"
  | "pause";

// ── Command Bus Payloads ──

export type MissionCommand =
  | { op: "read" }
  | { op: "delegate"; stepId: string; role: string; brief: string; transferSummary?: string }
  | { op: "report"; stepId: string; status: "completed" | "failed"; summary: string; filesChanged?: string[]; commits?: string[]; testResults?: string; handoffSummary?: string }
  | { op: "gate"; stepId: string; gate: MissionGateType; status: "pass" | "fail"; evidence?: string }
  | { op: "advance"; stepId: string }
  | { op: "pause"; reason: string };

// ── Structured Response (runner → orchestrator via queueMessage) ──

/** Structured response sent from runner into orchestrator session. */
export interface MissionResponse {
  type: "worker_report" | "gate_update";
  stepId: string;
  /** Worker report fields (present when type === "worker_report") */
  workerStatus?: "completed" | "failed";
  summary?: string;
  filesChanged?: string[];
  commits?: string[];
  testResults?: string;
  handoffSummary?: string;
  /** Gate update fields (present when type === "gate_update") */
  gate?: MissionGateType;
  gateStatus?: "pass" | "fail";
  /** Computed by runner — read-only for orchestrator */
  allGatesPassed: boolean;
  /** Current status of all gates for this step */
  gateSnapshot: Array<{ gate: MissionGateType; status: "pass" | "fail" | "pending" }>;
}

// ── Runtime DB Row Types ──

export interface MissionRunRow {
  id: number;
  mission_name: string;
  cwd: string;
  user_profile: string | null;
  status: MissionRunStatus;
  current_step_index: number;
  current_cycle: number;
  orchestrator_session_id: string | null;
  definition_snapshot: string; // JSON-serialized MissionConfig
  halt_kind: MissionHaltKind | null;
  halt_message: string | null;
  warning: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface MissionStepRunRow {
  id: number;
  run_id: number;
  step_id: string;
  step_order: number;
  role: string;
  title: string;
  status: MissionStepStatus;
  active_assignment_id: number | null;
  started_at: number | null;
  completed_at: number | null;
}

export interface MissionAssignmentRow {
  id: number;
  run_id: number;
  step_id: string;
  role: string;
  session_id: string | null;
  source_session_id: string | null;
  status: MissionAssignmentStatus;
  brief: string | null;
  result_summary: string | null;
  failure_kind: MissionHaltKind | null;
  started_at: number;
  completed_at: number | null;
}

export interface MissionTransferRow {
  id: number;
  run_id: number;
  step_id: string;
  from_session_id: string | null;
  to_session_id: string | null;
  kind: MissionTransferKind;
  summary: string | null;
  details: string | null; // JSON
  created_at: number;
}

export interface MissionGateResultRow {
  id: number;
  run_id: number;
  step_id: string;
  assignment_id: number | null;
  gate_type: MissionGateType;
  status: "pass" | "fail";
  evidence: string | null; // JSON
  checked_at: number;
}

// ── API Response Types (returned to UI/REST) ──

export interface MissionListItem {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  stepCount: number;
  roles: string[];
  tags: string[];
}

export interface MissionRunSummary {
  id: number;
  runNumber: number;
  missionName: string;
  status: MissionRunStatus;
  currentStepIndex: number;
  currentCycle: number;
  haltKind: MissionHaltKind | null;
  haltMessage: string | null;
  warning: string | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface MissionStepRunSummary {
  id: number;
  stepId: string;
  stepOrder: number;
  role: string;
  title: string;
  status: MissionStepStatus;
  startedAt: number | null;
  completedAt: number | null;
}

export interface MissionAssignmentSummary {
  id: number;
  stepId: string;
  role: string;
  sessionId: string | null;
  status: MissionAssignmentStatus;
  brief: string | null;
  resultSummary: string | null;
  failureKind: MissionHaltKind | null;
  startedAt: number;
  completedAt: number | null;
}

export interface MissionTransferSummary {
  id: number;
  stepId: string;
  fromSessionId: string | null;
  toSessionId: string | null;
  kind: MissionTransferKind;
  summary: string | null;
  createdAt: number;
}

export interface MissionGateResultSummary {
  id: number;
  stepId: string;
  gateType: MissionGateType;
  status: "pass" | "fail";
  evidence: string | null;
  checkedAt: number;
}
