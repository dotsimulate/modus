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
  /** When set, extract payload[sessionKey] as a tag to route to an existing session.
   *  If a session with that tag exists, the payload is sent as a follow-up message
   *  instead of creating a new action run. If no session exists, a new run fires
   *  and the resulting session is tagged for future lookups. */
  sessionKey?: string;
};

export type ManualTrigger = {
  type: "manual";
};

export type ActionChainTrigger = {
  type: "action";
  source: string;                      // action name to watch
  condition: "any" | "done" | "error"; // when to fire
};

export type SessionTriggerEvent =
  | {
      role: "user" | "assistant";
      round: number | `every:${number}` | `after:${number}`;
      at: "start" | "end";
    }
  | "archived"
  | "deleted";

export type SessionTrigger = {
  type: "session";
  on: SessionTriggerEvent;
  excludeTags?: string[];      // default: ["internal"] — prevents cascade
};

export type Trigger = IntervalTrigger | WebhookTrigger | ManualTrigger | ActionChainTrigger | SessionTrigger;

// ── Multi-Step Sequences ──

/** A step in a multi-profile action sequence (steps beyond the initial agentProfile) */
export interface ActionStep {
  profile: string;
  prompt?: string;           // static prompt — used if gather doesn't handle this stepIndex
  contextMode?: "full" | "summary" | "lastResponse";
}

// ── Action Config ──

/** On-disk action config — lives in actions/<name>/action.json */
export interface ActionConfig {
  name: string;
  description: string;
  enabled: boolean;
  origin?: "harness" | "project";

  // ── What to run ──
  agentProfile: string;

  // ── Multi-step profile sequence (optional) ──
  steps?: ActionStep[];

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

  // ── Artifacts ──
  artifacts?: ArtifactSpec[];

  // ── Notifications ──
  notify?: NotifySpec[];

  // ── Static inputs (passed to ctx.inputs in gather/verify/afterRun) ──
  inputs?: Record<string, unknown>;

  // ── Moves (activate moves on the spawned session) ──
  moves?: ActionMoveSpec[];

  // ── Page (action-owned page in the nav) ──
  page?: ActionPageDeclaration;

  // ── Tags (freeform labels — used for filtering, grouping, archiving) ──
  tags?: string[];

  // ── UI preferences (managed by frontend) ──
  preferences?: Record<string, boolean>;
}

// ── Artifacts ──

export interface ArtifactSpec {
  name: string;                          // logical name: "cartoon", "report"
  mime: string;                          // mime type: "image/svg+xml", "application/json"
  required?: boolean;                    // default true — auto-verify fails if missing
}

// ── Notifications ──

export type NotifyStatus = "done" | "error" | "error-transient" | "failed-verification" | "exhausted" | "skipped";

export interface NotifySpec {
  on: NotifyStatus | NotifyStatus[];   // trigger on these statuses
  channel: string;                     // references a named channel in _global.json
  message?: string;                    // template with {action}, {run}, {status}, {error}, {cost}, {duration}, {profile}
}

// ── Trigger Info (passed to gather/afterRun) ──

export type SessionTriggerPayload = {
  sessionId: string;
  userProfile: string | undefined;
  preview: string;
  title: string | null | undefined;
  tags: string[];
  messageCount: number;
  round: number;
  role: "user" | "assistant";
  /** Truncated last assistant response (available on assistant round end triggers) */
  lastResponse?: string;
  /** Exact assistant turn seq when available (assistant round end triggers) */
  assistantSeq?: number;
  /** Stable assistant message UUID when the provider supplies one */
  assistantMessageUuid?: string;
};

export type TriggerInfo = {
  type: "interval" | "webhook" | "manual" | "action" | "session";
  payload?: unknown;                   // webhook body, source RunResult, or SessionTriggerPayload
  source?: string;                     // source action name (for action chains)
  /** Tag to apply to the session created by this webhook (for session routing) */
  webhookSessionTag?: string;
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
  cwd: string | undefined;             // working directory from action config (cfg.cwd)
  inputs: Record<string, unknown>;     // inputs from action.json (cfg.inputs ?? {})

  // ── Multi-step context ──
  stepIndex: number;                   // 0 for single-step or step 0, 1+ for subsequent
  totalSteps: number;                  // 1 for single-step actions
  previousStepResult?: SessionOutcome | null;  // result from prior step

  // ── Verify/retry context ──
  attempt: number;                     // 1-based, 1 = first try
  lastVerifyError?: string;            // reason from failed verify, if retrying

  // ── Logging ──
  /** Emit a log entry visible in the activity log. Use for debugging and tracing action behavior. */
  log(message: string, metadata?: Record<string, unknown>): void;

  // ── Artifact helpers ──
  /** Returns the artifact directory for this attempt. Created on first access. */
  artifactDir(): string;
  /** Returns a safe path for storing run artifacts. Namespaced so reruns don't collide. */
  artifactPath(filename: string): string;
  /** Returns the expected path for a declared artifact by logical name.
   *  Derives extension from the artifact spec's mime type. Only works when
   *  `artifacts` is declared in action.json — throws if name not found. */
  artifact(name: string): string;
  /** Attach an already-written artifact file to a specific session turn. */
  attachArtifact(opts: {
    sessionId: string;
    seq: number;
    targetMessageUuid?: string;
    path: string;
    name: string;
    mime: string;
    previewText?: string;
    metadata?: Record<string, unknown>;
  }): {
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

  // ── Terminal ──
  /** Create a managed terminal owned by this action. The terminal is visible
   *  in the UI via the action-card widget and persists until explicitly killed
   *  or the action run completes. */
  createTerminal(opts?: {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
    env?: Record<string, string>;
  }): ActionTerminalHandle;

  // ── Utilities ──
  /** Render an SVG file to a base64-encoded PNG string. Returns null on failure. */
  svgToPngBase64(svgPath: string, width?: number): string | null;
}

/** Handle returned by ActionContext.createTerminal() */
export interface ActionTerminalHandle {
  id: string;
  /** Write data to the terminal's stdin. */
  write(data: string): void;
  /** Kill the terminal process. */
  kill(): void;
  /** Wait for the terminal process to exit. Returns the exit code or null. */
  waitForExit(): Promise<number | null>;
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
  status: "done" | "error" | "failed-verification" | "error-transient" | "skipped";
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
  gather(ctx: ActionContext): Promise<string | ActionContent | null>;
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
  /** Reconstructed user/assistant turns with text, thinking, and tool calls */
  getSessionMessages(sessionId: string): SessionTurn[];

  // ── Session mutations ──

  /** Update a session's title */
  updateSessionTitle(id: string, title: string | null): void;
  /** Add a tag to a session (no-op if already present) */
  addSessionTag(id: string, tag: string): void;
  /** Remove a tag from a session (no-op if not present) */
  removeSessionTag(id: string, tag: string): void;

  // ── Activity log ──

  /** Query the activity log (defaults: last 200 entries) */
  getActivityLog(opts?: { userProfile?: string; since?: number; limit?: number; eventType?: string }): ActivityEntry[];
  /** Get event type counts over a time window (defaults: last 24h) */
  getActivitySummary(opts?: { userProfile?: string; hours?: number }): ActivitySummaryEntry[];
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

export interface SessionTurn {
  role: "user" | "assistant";
  seq: number;
  text: string;
  thinking?: string;
  toolCalls?: { name: string; input: Record<string, unknown>; result?: string }[];
  uuid?: string;
  artifacts?: Array<{
    id: number;
    sessionId: string;
    seq: number;
    targetMessageUuid?: string;
    name: string;
    mime: string;
    url: string;
    createdAt: number;
    previewText?: string;
    metadata?: Record<string, unknown>;
    sourceAction?: string;
  }>;
  timestamp: number;
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
  runStartedAt: number | null;         // wall-clock start of current run (for stuck detection)
  lastStatus: string | null;
  totalCostUsd: number;
  transientAttempts: number;           // network error retry counter
}

/** Runtime state per action (in-memory, not persisted) */
export interface ActionState {
  config: ActionConfig;
  /** Filesystem directory containing this action's config + context.ts */
  actionDir: string;
  origin: "harness" | "project";
  activeExecutions: Map<number, ExecutionState>; // keyed by execution ID
  lastRunAt: number | null;
  nextRunAt: number | null;
  exhausted: boolean;
  // Derived: running = activeExecutions.size > 0
  // Derived: lastStatus from most recent execution
}

// ── Constants ──

// ── Activity Types (mirror of activity.ts row shapes) ──

export interface ActivityEntry {
  id: number;
  user_profile: string | null;
  event_type: string;
  session_id: string | null;
  action_name: string | null;
  agent_profile: string | null;
  summary: string | null;
  metadata: string | null;
  created_at: number;
}

export interface ActivitySummaryEntry {
  event_type: string;
  count: number;
  latest: number;
}

// ── Action Move Spec ──

/** Declares a move to activate on the action's spawned session */
export interface ActionMoveSpec {
  /** Move name (must exist in harness/moves/ or .modus/moves/) */
  name: string;
  /** Inputs to pass to the move's gather() */
  inputs?: Record<string, unknown>;
}

/** Max depth for action→action chain triggers to prevent infinite loops */
export const MAX_CHAIN_DEPTH = 8;

// ── Page Declaration ──

/** Declared in action.json — registers a page in the nav for this action */
export interface ActionPageDeclaration {
  /** Page ID used in URL hash (e.g. #page:monitor-dash) */
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
