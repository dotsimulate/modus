/**
 * Scheduler Types — shared contracts for the schedule system.
 *
 * Schedules are separate from agent profiles:
 *   - Agent profiles define HOW an agent behaves (model, tools, prompt)
 *   - Schedules define WHEN and WITH WHAT CONTEXT an agent runs
 *
 * Each schedule is a directory: schedules/<name>/ containing:
 *   - schedule.json  → ScheduleConfig (timing, agent profile ref, active hours)
 *   - context.ts     → ScheduleModule (gather function that builds the prompt)
 */

/** On-disk schedule config — lives in schedules/<name>/schedule.json */
export interface ScheduleConfig {
  name: string;
  description: string;
  enabled: boolean;

  // ── What to run ──
  agentProfile: string;

  // ── Timing ──
  interval: string;                      // "30s", "5m", "1h", "4h", etc.
  intervalFrom?: "completion" | "start"; // when to start the next interval (default: "completion")
  activeHours?: {
    start: string;                       // "09:00" (24h format, local time)
    end: string;                         // "22:00"
  };

  // ── Run layer ──
  maxRuns?: number;                      // per-cycle limit (or lifetime cap if no cycleInterval)
  maxTurns?: number;                     // override agent profile's maxTurns

  // ── Cycle layer ──
  cycleInterval?: string;               // outer rhythm: "1d", "12h", etc. — resets run counter each cycle
  maxCycles?: number;                    // total cycle cap — auto-disables after N cycles complete

  // ── Session overrides (optional — profile provides defaults) ──
  model?: string;
  effort?: string;
  cwd?: string;
  tools?: string[];
  disallowedTools?: string[];
  loadProjectSettings?: boolean;
}

/**
 * Read-only DB API exposed to schedule context gatherers.
 * All methods are scoped and safe — no writes, no mutations.
 */
export interface ScheduleDB {
  // ── Own schedule runs ──
  /** Summaries from this schedule's completed runs (chronological order) */
  getRunSummaries(limit?: number): RunSummary[];
  /** Full run metadata for this schedule (newest first) */
  getRunHistory(limit?: number): RunMeta[];

  // ── Cross-schedule ──
  /** Run metadata from any schedule by name */
  getScheduleRuns(scheduleName: string, limit?: number): RunMeta[];

  // ── Sessions ──
  /** List recent sessions (non-archived) */
  listSessions(limit?: number): SessionInfo[];
  /** Get a specific session by ID */
  getSession(id: string): SessionInfo | null;
  /** Full-text search across all session content */
  searchSessions(query: string, limit?: number): SearchResult[];

  // ── Events ──
  /** Get events for a session (optionally after a sequence number) */
  getEvents(sessionId: string, afterSeq?: number): EventInfo[];
}

/** Session info exposed to schedules (read-only projection of SessionRow) */
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
  scheduleName: string | null;
}

/** Search result exposed to schedules */
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

/** Event info exposed to schedules */
export interface EventInfo {
  id: number;
  sessionId: string;
  seq: number;
  type: string;
  subtype: string | null;
  data: string;
  createdAt: number;
}

/** Context object passed to gather() — provides DB-backed continuity */
export interface ScheduleContext {
  scheduleName: string;
  runNumber: number;
  cycleNumber: number;
  cycleRunIndex: number;        // 0-based index within current cycle
  lastRunAt: Date | null;
  db: ScheduleDB;

  // Future seeds:
  // tools: DynamicToolRegistry
  // provide(tool: ToolDef): void
}

/** What a schedule's context.ts module must export */
export interface ScheduleModule {
  gather(ctx: ScheduleContext): Promise<string>;
  // Future seed:
  // check?(ctx: ScheduleContext, result: RunResult): Promise<string | null>;
}

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
}

/** Runtime state per schedule (in-memory, not persisted) */
export interface ScheduleState {
  config: ScheduleConfig;
  running: boolean;
  currentSessionId: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: string | null;
  runNumber: number;
  // Cycle tracking
  cycleNumber: number;          // current cycle (1-based)
  cycleRunCount: number;        // runs completed in current cycle
  cycleStartedAt: number | null; // when current cycle began
}
