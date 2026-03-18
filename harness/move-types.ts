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
 *   - persistent: ambient gather — gather() re-runs per turn, injecting context
 *                 into every user message. No token/submit lifecycle. Toggle on/off.
 *
 * API contract moves:
 *   Moves can declare an `api` field with named ops. On activation, the
 *   move-runner registers handlers from context.ts, creates an API token
 *   (mapi- prefix), and passes it to gather(). The token supports repeated
 *   submissions — handlers manage state via the MoveStateAPI.
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

  // ── Persistent (ambient gather) ──
  /** When true, this move runs as an ambient gather — no token/submit lifecycle.
   *  gather() re-runs on every user turn and appends context to the prompt.
   *  The move stays active until explicitly deactivated. */
  persistent?: boolean;

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

  // ── API contract (multi-submit ops) ──
  api?: MoveApiDeclaration;

  // ── Widget (move-local UI component) ──
  widget?: MoveWidgetDeclaration;

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
  /** Gather context for this move. Return null to skip/bail (no injection this turn). */
  gather?(ctx: MoveContext): Promise<string | null>;
  onSubmit?(
    ctx: MoveContext,
    data: Record<string, unknown>,
    inputs: Record<string, unknown>,
  ): Promise<SubmitResult>;
  /** API op handlers — keyed by op name, registered on activation for api moves */
  handlers?: Record<string, MoveApiHandler>;
  /** Optional — customize instance labels for the resume select input */
  listInstances?(states: Array<{ instanceId: string; state: unknown }>): Array<{ label: string; value: string }>;
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

  // ── API contract fields (set when move has api declaration) ──
  /** API token for modus_submit (mapi- prefix, reusable across submissions) */
  apiToken?: string;
  /** Instance identifier (portable, can be shared across sessions) */
  instanceId?: string;
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

// ── Ambient Move Registration (persistent/gather-only moves) ──

export interface AmbientMoveRegistration {
  moveName: string;
  sessionId: string;
  cwd: string;
  userProfile: string | undefined;
  inputs: Record<string, unknown>;
  activatedAt: number;
  moveRunId: number;
}

// ── Attach Request (widget-first activation, phase 1) ──

export interface AttachMoveOpts {
  moveName: string;
  sessionId?: string;
  inputs: Record<string, unknown>;
  cwd: string;
  userProfile?: string;
}

export interface AttachMoveResult {
  apiToken: string;
  instanceId: string;
  widget: {
    label: string;
    icon?: string;
    autoOpen: true;
    mountOnAttach: true;
    moduleUrl: string;
    moveName: string;
  };
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
  mode: "inline" | "branch" | "background" | "persistent";
  persistent?: boolean;                // true for ambient gather moves
  spawnedSessionId?: string;           // for branch/background
  prompt?: string;                     // for inline: rendered text to merge into user message
  moveRunId: number;
  apiToken?: string;                   // for api contract moves
  instanceId?: string;                 // for api contract moves
  widget?: {                           // for moves with a widget declaration
    label: string;
    icon?: string;
    autoOpen?: boolean;
    mountOnAttach?: boolean;
    moduleUrl: string;                 // "/api/moves/<name>/widget?cwd=..."
    moveName: string;
  };
}

// ── Move API Contract ──

/** Declared in move.json — UI component shipped with the move */
export interface MoveWidgetDeclaration {
  /** Filename in the move directory (e.g. "widget.tsx") */
  component: string;
  /** Where to render — only "right" (RightPanel) for now */
  panel?: "right";
  /** Tab label in the panel */
  label: string;
  /** Optional icon for the tab */
  icon?: string;
  /** Auto-open the panel when the move activates. Default false. */
  autoOpen?: boolean;
  /**
   * Mount the widget immediately when the move is attached to the composer,
   * BEFORE any message is sent. The widget opens, the user configures it
   * (writing to state via callOp), then triggers activation. Requires `api`
   * declaration on the move. Default false.
   */
  mountOnAttach?: boolean;
}

/** Declared in move.json — defines the ops a move provides */
export interface MoveApiDeclaration {
  /** Token prefix (default: move name). Tokens are `mapi-{prefix}-{instanceId}` */
  tokenPrefix?: string;
  /** Named operations this move provides */
  ops: Record<string, MoveOpDeclaration>;
  /** State configuration */
  state?: {
    /** Persist state to disk (survives restart). Default false (in-memory). */
    persist?: boolean;
  };
}

/** Single op declaration in move.json */
export interface MoveOpDeclaration {
  description: string;
  schema?: Record<string, unknown>;
}

/** Handler function signature for move API ops */
export type MoveApiHandler = (
  ctx: MoveApiContext,
  data: Record<string, unknown>,
) => Promise<{ ok: boolean; message?: string; error?: string }>;

/** Context passed to move API handlers on each op call */
export interface MoveApiContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  /** Project working directory from the move registration */
  cwd: string;
  /** Who initiated this call — agent via modus_submit or user via widget */
  caller: "agent" | "user";
  /** Instance state — get/set/delete */
  state: MoveStateAPI;
  /**
   * Push a message into the agent's session.
   * Pass an optional typed payload to emit a structured signal the agent can branch on.
   * With a payload, the agent receives: `[modus:{type}] {json}\n{message}`
   */
  notify: (message: string, emit?: { type: string; [key: string]: unknown }) => void;
}

/** State API for move handlers — abstracts in-memory vs persisted storage */
export interface MoveStateAPI {
  get<T = unknown>(): Promise<T | undefined>;
  set(value: unknown): Promise<void>;
  delete(): Promise<void>;
}

/** In-memory registration for an active move API */
export interface MoveApiRegistration {
  moveName: string;
  instanceId: string;
  sessionId: string;
  cwd: string;
  handlers: Record<string, MoveApiHandler>;
  persist: boolean;
}
