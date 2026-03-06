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

  // ── Cycle layer ──
  cycleInterval?: string;              // outer rhythm: "1d", "12h" — resets run counter each cycle
  maxCycles?: number;                  // total cycle cap — auto-disables after N cycles complete

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

/** Context object passed to gather() and afterRun() */
export interface ActionContext {
  actionName: string;
  runNumber: number;
  cycleNumber: number;
  cycleRunIndex: number;               // 0-based index within current cycle
  lastRunAt: Date | null;
  db: ActionDB;
  trigger: TriggerInfo;
}

/** Result passed to afterRun — everything the action needs to act on */
export interface RunResult {
  status: "done" | "error";
  response: string | null;             // agent's final response text
  summary: string | null;              // truncated summary stored in DB
  costUsd: number;
  durationMs: number;
  sessionId: string | null;
  error: string | null;
}

/** What an action's context.ts module must export */
export interface ActionModule {
  gather(ctx: ActionContext): Promise<string>;
  /** Optional hook — runs after the agent session completes.
   *  For side effects: API calls, notifications, hardware, etc.
   *  Failures here are logged but do NOT change the run's status. */
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

/** Runtime state per action (in-memory, not persisted) */
export interface ActionState {
  config: ActionConfig;
  running: boolean;
  currentSessionId: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  runNumber: number;
  cycleNumber: number;
  cycleRunCount: number;
  cycleStartedAt: number | null;
}

// ── Constants ──

/** Max depth for action→action chain triggers to prevent infinite loops */
export const MAX_CHAIN_DEPTH = 8;
