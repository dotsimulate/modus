import type { TurnContent } from "./db";
import type { WakeWhen, WakeHandle, HarnessContext } from "./harness-context";

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
  origin?: "harness" | "project" | "plugin";
  /** Runtime source metadata; never required in move.json. */
  pluginId?: string;
  pluginPath?: string;

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

  // ── Gather / prepare timing ──
  /** Override the gather() timeout (ms). Default 10000. Raise only for gathers that
   *  legitimately need longer — prefer prepare() for heavy setup so gather() stays fast. */
  gatherTimeoutMs?: number;
  /** Budget (ms) for the optional prepare() hook (heavy setup before the agent starts).
   *  Default 120000. */
  prepareTimeoutMs?: number;

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

  // ── Tool view (move-local transcript component) ──
  toolView?: MoveToolViewDeclaration;

  // ── Page (move-owned full page in the nav) ──
  page?: MovePageDeclaration;

  // ── Skills (available while the move is active) ──
  /** Installed skills to attach by name. Skills bundled at `<move>/skills/`
   *  attach automatically — this is for referencing ones installed elsewhere. */
  skills?: string[];

  // ── Capability declaration (runtime enforcement) ──
  capabilities?: MoveCapabilities;

  // ── Trust tier (set automatically or overridden in move.json) ──
  /**
   * Trust tier — controls default capability enforcement and audit level.
   *   - "builtin":  harness moves, fully trusted, capabilities default to all-allowed
   *   - "reviewed": project moves explicitly marked as reviewed, capabilities enforced as declared
   *   - "experimental": no capability enforcement, but all operations are logged (audit-only)
   *   When omitted, inferred from origin: "harness" → "builtin", "project" → "experimental".
   */
  trust?: "builtin" | "reviewed" | "experimental";

  // ── Metadata ──
  enabled?: boolean;
  tags?: string[];

  /**
   * Hide spawned branch/background sessions from the main sidebar by tagging
   * them "internal" at creation. Useful for background routing/gating moves
   * whose spawned sessions are infrastructure, not conversations the user
   * wants to browse. Has no effect on inline moves (they don't spawn).
   */
  hidden?: boolean;
}

// ── Move Capabilities (declared in move.json, enforced at runtime) ──

export interface MoveCapabilities {
  /** Allow ctx.run() shell execution. Default: true (unrestricted). */
  shell?: boolean;
  /** Allow harness.createSession(). Default: true. */
  sessionSpawn?: boolean;
  /** Allow harness.sendMessage(). Default: true. */
  sessionMessage?: boolean;
  /** Allow harness.triggerAction(). Default: true. */
  actionTrigger?: boolean;
  /** Allow harness.notify(). Default: true. */
  notify?: boolean;
  /**
   * Allow ctx.model.complete() one-shot model calls. Default: true.
   *
   * Separate from sessionSpawn even though both reach a model: a one-shot spends
   * tokens without producing anything the user can see in their session list, so
   * a move that should never cost money needs a way to say so that does not also
   * forbid spawning. Promotion of a one-shot into a session is gated by
   * sessionSpawn, since that is what it does.
   */
  modelCall?: boolean;
  /** Allowed network domains for shell commands (informational — not enforced at network layer). */
  network?: string[];
  /** Allow filesystem reads via ctx.db or gather. Default: true. */
  fileRead?: boolean;
  /** Allow filesystem writes (only relevant for onSubmit side effects). Default: true. */
  fileWrite?: boolean;
}

// ── Move Input (user form field) ──

/**
 * Sentinel the UI profile pickers prepend to every `agentProfiles` options
 * list. It means "the profile of the session this move runs in", but it is a
 * literal string until the move runner translates it at activation
 * (`resolveAgentProfileInputs`). When no session profile is known — a page
 * embed, a profile-less session — it reaches the move verbatim, so moves
 * should still treat it (or an empty value) as "no explicit choice".
 */
export const CURRENT_PROFILE_SENTINEL = "Current profile";

export interface MoveInputOption {
  value: string;
  label: string;
}

export interface MoveInputOptionsSource {
  type: "agentProfiles" | "projects" | "sessions";
  /** For project pickers, select the current project by default when possible. */
  defaultToCurrent?: boolean;
  /** For project pickers, bypass user-profile scope and show all registered projects. */
  scope?: "all" | "user";
  /** For session pickers, resolve sessions against another input's selected project path. */
  projectField?: string;
  /** For session pickers, prepend an empty/default option with this label. */
  emptyLabel?: string;
  /** Session query limit for dynamic session menus. */
  limit?: number;
}

export interface MoveInputVisibilityRule {
  input: string;
  equals?: string;
  notEquals?: string;
  isEmpty?: boolean;
  notEmpty?: boolean;
}

/**
 * Path policy for a `file` input.
 *
 * The value a file input produces is an absolute host path that move code will
 * open, so the policy is enforced server-side at activation
 * (`harness/move-file-input.ts`) and not merely in the picker: a page embed or
 * SDK caller can post any string it likes.
 */
export interface MoveInputFilePolicy {
  /**
   * Accepted file extensions, e.g. `[".png", ".jpg"]`. Matched case-insensitively;
   * a leading dot is optional. Omit to accept any file.
   */
  accept?: string[];
  /**
   * Allow selecting a file outside the project directory. Default `false` —
   * the file must resolve inside the activating project root.
   */
  allowOutsideProject?: boolean;
}

export interface MoveInput {
  name: string;
  label?: string;
  type: "text" | "textarea" | "select" | "toggle" | "number" | "file";
  options?: Array<string | MoveInputOption> | string;   // literal array or template var ref "{{agentProfiles}}"
  optionsSource?: MoveInputOptionsSource;
  /** Only for `type: "file"`. */
  file?: MoveInputFilePolicy;
  visibleWhen?: MoveInputVisibilityRule;
  required?: boolean;
  default?: unknown;
  placeholder?: string;
}

// ── Move Module (context.ts exports) ──

export interface MoveModule {
  /** Optional heavy-setup hook run BEFORE gather() on explicit activation (activateMove /
   *  activateAttachedMove): launch a program, poll until an MCP is reachable, etc. Awaited
   *  with its own longer budget (prepareTimeoutMs, default 120s). Keep gather() fast — it
   *  just builds the prompt; do the slow readiness work here. */
  prepare?(ctx: MoveContext): Promise<void>;
  /** Gather context for this move. Return null to skip/bail (no injection this turn). */
  gather?(ctx: MoveContext): Promise<string | null>;
  onSubmit?(
    ctx: MoveContext,
    data: Record<string, unknown>,
    inputs: Record<string, unknown>,
  ): Promise<SubmitResult>;
  /** Optional hook for assistant round-end reactions on an active move instance */
  onAssistantTurn?(ctx: MoveAssistantTurnContext): Promise<void>;
  /** API op handlers — keyed by op name, registered on activation for api moves */
  handlers?: Record<string, MoveApiHandler>;
  /** Infer op from data shape when the model omits the op field */
  inferOp?: (data: Record<string, unknown>) => string | null | undefined;
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
  /** Manifest-declared settings for the plugin that supplied this move. */
  pluginSettings: HarnessContext["pluginSettings"];

  /** Resolve a secret by name. Checks secrets file first, then process.env. */
  secrets: MoveSecrets;

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

  // ── Process-scoped store (set when move has api declaration) ──
  /** Read from the process-scoped instance store. Survives module reloads. */
  store?: <T = unknown>() => T | undefined;
  /** Write to the process-scoped instance store. Survives module reloads. */
  setStore?: (value: unknown) => void;

  // ── State API (set when move has api declaration) ──
  /** Instance state — get/set/delete. Available for API moves (always wired when api declaration exists). */
  state?: MoveStateAPI;
}

// ── Move Secrets (safe access to secrets/env vars) ──

export interface MoveSecrets {
  /** Resolve a secret by name. Checks secrets file first, then process.env. */
  resolve: (name: string) => string | undefined;
  /** Check if a secret is configured without exposing the value. */
  isSet: (name: string) => boolean;
}

// ── Harness Bridge (server-side operations available to onSubmit) ──

export interface HarnessBridge {
  createSession: (opts: {
    profile: string;
    prompt: string;
    cwd?: string;
    userProfile?: string;
    tags?: string[];
  }) => Promise<string>;
  sendMessage: (sessionId: string, content: string) => Promise<void>;
  triggerAction: (actionName: string) => Promise<void>;
  notify: (spec: { channel: string; body: string }) => Promise<void>;
  /** Add a tag to a session. */
  addSessionTag: (sessionId: string, tag: string) => Promise<void>;
  /** List all available moves for the current project. */
  listMoves: () => MoveConfig[];
  /** Activate a move (inline/branch/background). Returns activation result. */
  activateMove: (opts: {
    moveName: string;
    inputs?: Record<string, unknown>;
    sessionId?: string;
    modeOverride?: "inline" | "branch" | "background";
  }) => Promise<{ token: string; mode: string; spawnedSessionId?: string; prompt?: string; requiresDispatch: boolean; moveRunId: number }>;
  /** Watch a session's assistant turns. Returns an unsubscribe function. */
  watchSessionTurns: (sessionId: string, onTurn: (turn: TurnContent) => void | Promise<void>) => () => void;
  /**
   * One-shot model calls — prompt in, text out, no session spawned. Use this
   * rather than createSession when the answer is a value, not a conversation.
   */
  model: HarnessContext["model"];
}

// ── Move DB (read-only queries available to context.ts) ──

export interface MoveDB {
  listSessions(limit?: number): SessionRef[];
  getSession(id: string): SessionRef | null;
  searchSessions(query: string, limit?: number): SearchRef[];
  getMoveHistory(moveName: string, limit?: number): MoveRun[];
  /** Get structured message content (user/assistant turns) for a session. */
  getSessionMessages(sessionId: string): TurnContent[];
}

export interface SessionRef {
  id: string;
  preview: string;
  profile: string | null;
  status: string;
  lastMessageAt: number;
  user_profile?: string | null;
  provider?: string | null;
  model?: string | null;
  cwd?: string | null;
  created_at?: number;
  updated_at?: number;
  last_message_at?: number;
  message_count?: number;
  total_cost_usd?: number;
  title?: string | null;
  tags?: string;
  parent_session_id?: string | null;
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
  apiToken?: string;                   // API contract token (so onSubmit can pass it to spawned sessions)
  instanceId?: string;                 // API contract instance ID
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
  apiToken?: string;
  instanceId?: string;
  /** If true, auto-deregister after the next gather (one-shot ambient) */
  oneShot?: boolean;
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
    cache?: "instance" | "module" | "none";
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
  /** Agent profile of the activating session, used to translate the
   *  "Current profile" picker sentinel. Falls back to the session's own
   *  profile when omitted and sessionId is set. */
  agentProfile?: string;
  modeOverride?: "inline" | "branch" | "background";
  forceNewSession?: boolean;
}

// ── Activation Result ──

export interface ActivateMoveResult {
  token: string;
  mode: "inline" | "branch" | "background" | "persistent";
  /** True when the caller must send `prompt`; activation itself never sends an inline prompt. */
  requiresDispatch: boolean;
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
    cache?: "instance" | "module" | "none";
    moduleUrl: string;                 // "/api/moves/<name>/widget?cwd=..."
    moveName: string;
  };
}

// ── Move API Contract ──

/** Declared in move.json — move registers a full page in the nav */
export interface MovePageDeclaration {
  /** Page ID used in URL hash (e.g. #move-page:memory → id: "memory") */
  id: string;
  /** Display title in the nav bar */
  title: string;
  /** Optional icon for the nav link */
  icon?: string;
  /** Show in the main nav bar. Default true. */
  nav?: boolean;
  /** Full layout tree — when present, the page renders as a composable layout
   *  (same schema as .modus/pages/*.json) instead of a bare widget page. */
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
  /**
   * Widget caching strategy. Controls how the widget survives React re-renders.
   *   - "instance" (default): DOM stays alive when hidden — full state preservation.
   *   - "module": JS module is cached but React can unmount/remount freely.
   *     Component state resets but no import flash.
   *   - "none": always re-import the module. For development/iteration.
   */
  cache?: "instance" | "module" | "none";
}

/** Declared in move.json — replaces this move's modus_submit tool-call rendering */
export interface MoveToolViewDeclaration {
  /** Filename in the move directory (e.g. "tool-view.tsx") */
  component: string;
  /** Restrict takeover to these API op names. Omit to claim every op. */
  ops?: string[];
  /** Replace the entire tool row (default) or only its expanded body. */
  takeover?: "block" | "body";
  /** Module caching strategy. "instance" currently shares "module" semantics in the transcript. */
  cache?: "instance" | "module" | "none";
}

/** Declared in move.json — defines the ops a move provides */
export interface MoveApiDeclaration {
  /** Token prefix (default: move name). Tokens are `mapi-{prefix}-{instanceId}` */
  tokenPrefix?: string;
  /** Fallback op when model omits the op name (llama.cpp autoparser workaround) */
  defaultOp?: string;
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

/**
 * Handler function signature for move API ops.
 *
 * Extra keys beyond ok/message/error are part of the contract, not a leak:
 * handleMoveApiSubmit returns the result verbatim, the HTTP route serializes it
 * whole, and modus_submit renders the remaining keys to the calling agent. The
 * index signature says so, because a handler that has to smuggle a payload
 * through `message` is working around a type rather than an implementation.
 */
export type MoveApiHandler = (
  ctx: MoveApiContext,
  data: Record<string, unknown>,
) => Promise<{ ok: boolean; message?: string; error?: string } & Record<string, unknown>>;

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
  /** Read-only database queries (sessions, messages, search) */
  db: MoveDB;
  /** Resolve secrets by name */
  secrets: MoveSecrets;
  /** Manifest-declared settings for the plugin that supplied this move. */
  pluginSettings: HarnessContext["pluginSettings"];
  /** Broadcast an event immediately to this move instance's mounted widget/tool view. */
  emit: (event: { type: string; [key: string]: unknown }) => void;
  /**
   * Notify the side opposite the caller.
   *
   * Agent (`modus_submit`) calls inject `message` into the session. With `emit`,
   * the injected text is `[modus:{type}] {json}\n{message}`. User/widget calls
   * never inject `message` back into the agent; they broadcast `emit` as a
   * `move-widget-event`, and do nothing visible when `emit` is omitted.
   */
  notify: (message: string, emit?: { type: string; [key: string]: unknown }) => void;
  /** Send a message to any existing session in this project. */
  sendMessage: (sessionId: string, message: string) => Promise<void>;

  // ── Orchestration (sourced from the Harness Context). See
  //    docs/generated/authoring-contracts.md for the per-surface member list. ──

  /**
   * Shell execution, gated by `capabilities.shell` exactly as it is for
   * `MoveContext.run` and every other Harness Context caller.
   *
   * Handlers had no shell for a long time, and the effect was the opposite of
   * containment: an author who needed to run a command imported `child_process`
   * instead, which bypasses the capability gate and the audit log entirely. A
   * gated path that is declared and logged is the safer of the two.
   */
  shell: { run(cmd: string): Promise<string> };

  /** Spawn a new session. */
  createSession: (opts: {
    profile: string;
    prompt: string;
    cwd?: string;
    userProfile?: string;
    tags?: string[];
  }) => Promise<string>;
  /** Trigger an action by name. */
  triggerAction: (actionName: string) => Promise<void>;
  /** Activate a move (inline/branch/background). Returns the activation result. */
  activateMove: (opts: {
    moveName: string;
    inputs?: Record<string, unknown>;
    sessionId?: string;
    modeOverride?: "inline" | "branch" | "background";
  }) => Promise<{ token: string; mode: string; spawnedSessionId?: string; prompt?: string; requiresDispatch: boolean; moveRunId: number }>;
  /** Watch a session's assistant turns. Returns an unsubscribe function. */
  watchSessionTurns: (sessionId: string, onTurn: (turn: TurnContent) => void | Promise<void>) => () => void;
  /** Wake a session (id or tag) now, or on a schedule (at/every/onEvent). Fans out to a tagged team. */
  wake: (target: string, content: string, when?: WakeWhen) => Promise<WakeHandle>;
  /** Send arbitrary content to a named channel (Discord/Slack/file). The egress primitive. */
  channels: {
    send: (channel: string, payload: { text: string; data?: Record<string, unknown> }) => Promise<{ ok: boolean; error?: string }>;
  };
  /**
   * One-shot model calls — prompt in, text out, no session spawned. The cheap
   * rung below `createSession`, for transforms whose answer is a value rather
   * than a conversation. PI-family providers only; see HarnessModel.
   */
  model: HarnessContext["model"];

  /** Read from the process-scoped instance store. Survives module reloads. */
  store: <T = unknown>() => T | undefined;
  /** Write to the process-scoped instance store. Survives module reloads. */
  setStore: (value: unknown) => void;

  /** Register a file as a session artifact (for video, audio, images, etc.) */
  insertArtifact: (opts: {
    sessionId: string;
    name: string;
    mime: string;
    path: string;
    seq?: number;
    previewText?: string;
    metadata?: Record<string, unknown>;
  }) => number;
}

/** Context passed to assistant turn hooks on active move instances */
export interface MoveAssistantTurnContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  cwd: string;
  userProfile: string | undefined;
  state: MoveStateAPI;
  session: {
    lastAssistantText: string;
    seq: number;
    profile: string | undefined;
    exchangeCount: number;
  };
  assistant: TurnContent;
  emit: (event: { type: string; payload?: Record<string, unknown> }) => void;
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
  userProfile?: string;
  handlers: Record<string, MoveApiHandler>;
  /** Persist handler state values to disk. */
  persist: boolean;
  /** Persist the token-to-handler registration so it survives a harness restart. */
  persistRegistration?: boolean;
  defaultOp?: string;
  inferOp?: (data: Record<string, unknown>) => string | null | undefined;
}
