/**
 * Action Types — shared contracts for the action system.
 *
 * Actions are the automation primitive in MO:
 *   - Agent profiles define HOW an agent behaves (model, tools, prompt)
 *   - Actions define WHEN, WHY, and WITH WHAT CONTEXT an agent runs
 *
 * Each action is a directory: actions/<name>/ containing:
 *   - action.json  → ActionConfig
 *   - context.ts   → ActionModule (gather + optional afterRun)
 */

// ── Trigger Types ──

export type IntervalTrigger = {
  type: "interval";
  every: string;                       // "30s", "5m", "1h", "4h", "1d"
  from?: "completion" | "start";       // default: "completion"
  activeHours?: {
    start: string;                     // "09:00" (24h format, local time)
    end: string;                       // "22:00" — wraps midnight: 22:00-06:00 = 10pm to 6am
  };
};

export type WebhookTrigger = {
  type: "webhook";
  token?: string;                      // auto-generated if absent, stored in config
};

export type ManualTrigger = {
  type: "manual";
};

export type ActionChainTrigger = {
  type: "action";
  source: string;                      // action name to watch
  condition: "any" | "done" | "error"; // when to fire
};

export type Trigger = IntervalTrigger | WebhookTrigger | ManualTrigger | ActionChainTrigger;

// ── Action Config ──

/** On-disk action config — lives in actions/<name>/action.json */
export interface ActionConfig {
  name: string;
  description: string;
  enabled: boolean;

  // ── What to run ──
  agentProfile: string;

  // ── When to run ──
  trigger: Trigger;

  // ── Run layer ──
  maxRuns?: number;                    // per-cycle limit (or lifetime cap if no cycleInterval)
  maxTurns?: number;                   // override agent profile's maxTurns
  maxRetries?: number;                 // verify retries per run, default 0

  // ── Resilience ──
  onGatherError?: "fail" | "retry";    // default "fail" — "retry" uses verify retry loop
  maxTransientRetries?: number;        // network error retries, default 2
  retryBackoff?: string;               // backoff between transient retries, default "2m"
  onTransientFailure?: "retry" | "skip"; // default "retry"

  // ── Cycle layer ──
  cycleInterval?: string;              // outer rhythm: "1d", "12h" — resets run counter each cycle
  maxCycles?: number;                  // total cycle cap — auto-disables after N cycles complete

  // ── Execution layer ──
  concurrency?: number;                // max simultaneous executions, default 1
  onExhausted?: "archive" | "idle" | "restart"; // default "archive"

  // ── User profile scoping ──
  userProfile?: string;

  // ── Session overrides (optional — profile provides defaults) ──
  provider?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;

  // ── UI preferences (managed by frontend) ──
  preferences?: Record<string, boolean>;
}

// ── Trigger Info (passed to gather/afterRun) ──

export type TriggerInfo = {
  type: "interval" | "webhook" | "manual" | "action";
  payload?: unknown;                   // webhook body or source RunResult
  source?: string;                     // source action name (for action chains)
};

// ── Context & Module ──

/** Context object passed to gather(), verify(), and afterRun() */
export interface ActionContext {
  actionName: string;
  executionId: number;                 // which execution this run belongs to
  runNumber: number;
  cycleNumber: number;
  cycleRunIndex: number;               // 0-based index within current cycle
  lastRunAt: Date | null;
  db: ActionDB;
  trigger: TriggerInfo;
  actionDir: string;                   // absolute path to actions/<name>/

  // ── Verify/retry context ──
  attempt: number;                     // 1-based, 1 = first try
  lastVerifyError?: string;            // reason from failed verify, if retrying

  // ── Artifact helpers ──
  /** Returns the artifact directory for this attempt. Created on first access. */
  artifactDir(): string;
  /** Returns a safe path for storing run artifacts. Namespaced so reruns don't collide. */
  artifactPath(filename: string): string;
}

// ── Session Outcome (returned by monitorSession, not yet finalized) ──

/** Raw session completion data — before verify decides the final run status */
export interface SessionOutcome {
  sessionStatus: "done" | "idle" | "error" | "timeout";
  response: string | null;
  summary: string | null;
  costUsd: number;
  error: string | null;
}

// ── Verify ──

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; retry?: boolean };

/** Result passed to afterRun — everything the action needs to act on */
export interface RunResult {
  status: "done" | "error" | "failed-verification" | "error-transient";
  response: string | null;             // agent's final response text
  summary: string | null;              // truncated summary stored in DB
  costUsd: number;
  durationMs: number;
  sessionId: string | null;
  error: string | null;
}

/** Content blocks for multipart messages (text + images/files) */
export type ActionContent = string | Array<
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
>;

/** What an action's context.ts module must export */
export interface ActionModule {
  gather(ctx: ActionContext): Promise<string | ActionContent>;
  /** Optional — runs after session completes but before run is finalized.
   *  Inspects output and decides whether to accept, reject, or retry. */
  verify?(ctx: ActionContext, result: RunResult): Promise<VerifyResult>;
  /** Optional hook — runs after the run is finalized as "done".
   *  For side effects: API calls, notifications, hardware, etc.
   *  Failures here are logged but do NOT change the run's status.
   *  NOT called on failed-verification or error — only on success. */
  afterRun?(ctx: ActionContext, result: RunResult): Promise<void>;
}

// ── DB API (read-only, exposed to context.ts) ──

export interface ActionDB {
  /** Summaries from this action's completed runs (chronological order) */
  getRunSummaries(limit?: number): RunSummary[];
  /** Full run metadata for this action (newest first) */
  getRunHistory(limit?: number): RunMeta[];
  /** Run metadata from any action by name */
  getActionRuns(actionName: string, limit?: number): RunMeta[];
  /** List recent sessions (non-archived) */
  listSessions(limit?: number): SessionInfo[];
  /** Get a specific session by ID */
  getSession(id: string): SessionInfo | null;
  /** Full-text search across all session content */
  searchSessions(query: string, limit?: number): SearchResult[];
  /** Get events for a session (optionally after a sequence number) */
  getEvents(sessionId: string, afterSeq?: number): EventInfo[];
}

// ── Data Types ──

export interface RunSummary {
  runNumber: number;
  summary: string;
  completedAt: number;
}

export interface RunMeta {
  id: number;
  runNumber: number;
  cycleNumber: number;
  sessionId: string | null;
  status: string;
  summary: string | null;
  startedAt: number;
  completedAt: number | null;
  costUsd: number;
  error: string | null;
  triggerType: string;
  afterRunError: string | null;
  attempts: number;
  verifyError: string | null;
  executionId: number | null;
}

export interface SessionInfo {
  id: string;
  preview: string;
  profile: string | null;
  model: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  messageCount: number;
  totalCostUsd: number;
  lastPrompt: string | null;
  lastResponse: string | null;
  cwd: string | null;
  actionName: string | null;
}

export interface SearchResult {
  sessionId: string;
  preview: string;
  profile: string | null;
  model: string | null;
  cwd: string | null;
  lastMessageAt: number;
  totalCostUsd: number;
  snippet: string;
}

export interface EventInfo {
  id: number;
  sessionId: string;
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  createdAt: number;
}

/** Runtime state per execution (in-memory, tracks one lifecycle instance) */
export interface ExecutionState {
  id: number;                          // DB row id
  actionName: string;
  status: "running" | "done" | "idle" | "reset" | "cancelled";
  startedAt: number;
  runNumber: number;                   // current run within this execution
  cycleNumber: number;
  cycleRunCount: number;
  cycleStartedAt: number | null;
  currentSessionId: string | null;
  lastStatus: string | null;
  totalCostUsd: number;
}

/** Runtime state per action (in-memory, not persisted) */
export interface ActionState {
  config: ActionConfig;
  activeExecutions: Map<number, ExecutionState>; // keyed by execution ID
  lastRunAt: number | null;
  nextRunAt: number | null;
  exhausted: boolean;
  // Derived: running = activeExecutions.size > 0
  // Derived: lastStatus from most recent execution
}

// ── Constants ──

/** Max depth for action→action chain triggers to prevent infinite loops */
export const MAX_CHAIN_DEPTH = 8;
