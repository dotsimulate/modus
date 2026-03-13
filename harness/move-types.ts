/**
 * Move Types — shared contracts for the move system.
 *
 * Moves are the user-facing invocation primitive in MO:
 *   - Agent profiles define HOW an agent behaves
 *   - Actions define WHEN automation runs
 *   - Moves define WHAT the user wants done right now
 *
 * Built-in harness moves live in `harness/moves/<name>/`.
 * Project-local moves live in `.modus/moves/<name>/`.
 * Project-local moves override built-ins with the same name.
 *
 * Each move is a directory containing:
 *   - move.json   → MoveConfig
 *   - context.ts  → MoveModule (optional gather + onSubmit)
 *   - context.ts gathers context and returns the prompt string directly
 *
 * Execution modes:
 *   - inline:     current agent handles it, blocking until submit/completion
 *   - branch:     spawn a sibling session, return a link/card
 *   - background: fire-and-forget with persisted status and later recall
 */

// ── Move Config (on-disk definition) ──

export interface MoveConfig {
  name: string;
  label: string;
  description: string;
  icon?: string;
  origin?: "harness" | "project";

  // ── User inputs (form fields before execution) ──
  inputs?: MoveInput[];

  // ── Submission contract ──
  schema?: Record<string, unknown>;    // full JSON Schema for harness validation
  schemaHint?: string;                 // compact shape shown to the model

  submit?: {
    required?: boolean;                // agent must call modus_submit
    retryOnInvalid?: boolean;          // return validation errors for retry
    maxAttempts?: number;              // cap invalid submissions (default 3)
  };

  // ── Execution mode ──
  mode?: "inline" | "branch" | "background";  // default: "inline"

  // ── Session behavior ──
  session?: {
    profileOverride?: string | null;   // swap agent profile for this move
    settingsOverride?: Record<string, unknown>;
    afterSubmit?: "continue" | "end" | `switch:${string}`;
  };

  // ── Prompt (inline fallback — used only if no context.ts gather()) ──
  prompt?: string | null;

  // ── Agent profile for branch/background modes ──
  agentProfile?: string;

  // ── Metadata ──
  enabled?: boolean;
  tags?: string[];
}

// ── Move Input (user form field) ──

export interface MoveInput {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number";
  options?: string[] | string;   // literal array or template var ref "{{agentProfiles}}"
  required?: boolean;
  default?: unknown;
  placeholder?: string;
}

// ── Move Module (context.ts exports) ──

export interface MoveModule {
  gather?(ctx: MoveContext): Promise<string>;
  onSubmit?(
    ctx: MoveContext,
    data: Record<string, unknown>,
    inputs: Record<string, unknown>,
  ): Promise<SubmitResult>;
}

// ── Move Context (passed to gather/onSubmit) ──

export interface MoveContext {
  moveName: string;
  sessionId: string;
  session: {
    lastAssistantText: string;
    seq: number;
    profile: string | undefined;
    exchangeCount: number;
  };
  cwd: string;
  userProfile: string | undefined;
  inputs: Record<string, unknown>;
  db: MoveDB;
  run: (cmd: string) => Promise<string>;
  harness: HarnessBridge;

  /** Attach metadata for tracing/graph rendering (stored as gatheredContext). */
  meta: (key: string, value: unknown) => void;

  // ── Available during gather() — set by move-runner before calling gather ──
  /** Short-lived move token for modus_submit */
  token?: string;
  /** Schema hint string (compact shape for the model) */
  schema?: string;
  /** Current ISO date */
  date?: string;
}

// ── Harness Bridge (server-side operations available to onSubmit) ──

export interface HarnessBridge {
  createSession: (opts: {
    profile: string;
    prompt: string;
    cwd?: string;
    userProfile?: string;
  }) => Promise<string>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  triggerAction: (actionName: string) => Promise<void>;
  notify: (spec: { channel: string; body: string }) => Promise<void>;
}

// ── Move DB (read-only queries available to context.ts) ──

export interface MoveDB {
  listSessions(limit?: number): SessionRef[];
  getSession(id: string): SessionRef | null;
  searchSessions(query: string, limit?: number): SearchRef[];
  getMoveHistory(moveName: string, limit?: number): MoveRun[];
}

export interface SessionRef {
  id: string;
  preview: string;
  profile: string | null;
  status: string;
  lastMessageAt: number;
}

export interface SearchRef {
  sessionId: string;
  snippet: string;
  profile: string | null;
}

export interface MoveRun {
  id: number;
  moveName: string;
  sessionId: string;
  mode: string;
  status: string;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
  spawnedSessionId: string | null;
}

// ── Submit Result (returned by onSubmit) ──

export interface SubmitResult {
  message?: string;
  notify?: { channel: string; body: string };
  error?: string;
  spawnedSessionId?: string;
}

// ── Move Token (server-side state for active contracts) ──

export interface MoveToken {
  token: string;
  sessionId: string;                    // source session ID, or "" for project-scoped activation
  moveName: string;
  mode: "inline" | "branch" | "background";
  schema: Record<string, unknown> | undefined;
  inputs: Record<string, unknown>;
  gatheredContext: Record<string, unknown>;
  cwd: string;
  userProfile: string | undefined;
  createdAt: number;
  ttl: number;                         // ms — default 10 minutes
  status: "pending" | "submitted" | "invalid" | "completed" | "expired";
  attempts: number;
  maxAttempts: number;
  moveRunId: number | null;            // DB row for tracking
  spawnedSessionId: string | null;     // for branch/background modes
}

// ── Activation Request (from UI/API) ──

export interface ActivateMoveOpts {
  moveName: string;
  sessionId?: string;
  inputs: Record<string, unknown>;
  cwd: string;
  userProfile?: string;
  modeOverride?: "inline" | "branch" | "background";
  forceNewSession?: boolean;
}

// ── Activation Result ──

export interface ActivateMoveResult {
  token: string;
  mode: "inline" | "branch" | "background";
  spawnedSessionId?: string;           // for branch/background
  moveRunId: number;
}
