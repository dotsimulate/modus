---
title: Authoring Contracts (generated)
audience: dev
covers: harness/action-operation-types.ts harness/harness-context.ts harness/move-types.ts harness/ui/src/move-tool-view.ts
---

<!-- GENERATED FILE — do not edit. Run `bun run docs:generate` from harness/. Drift fails docs-generated.test.ts. -->

# Authoring Contracts (generated)

Exactly which members each authoring surface exposes, quoted from source. Hand-written
docs describe intent and invariants; this describes shape. When the two disagree, this
one is right — it is regenerated from the declarations themselves.

## Surface matrix

`yes` = declared and required, `opt` = declared and optional, `—` = **absent**, not optional.
An absent member is a hard boundary: reaching for it is a type error in TypeScript and
`undefined` at runtime in plain JS.

| member | `MoveContext` | `MoveApiContext` | `HarnessContext` |
|---|---|---|---|
| `actions` | — | — | yes |
| `activateMove` | — | yes | — |
| `apiToken` | opt | — | — |
| `artifacts` | — | — | yes |
| `caller` | — | yes | — |
| `channels` | — | yes | yes |
| `createSession` | — | yes | — |
| `cwd` | yes | yes | — |
| `date` | opt | — | — |
| `db` | yes | yes | yes |
| `emit` | — | yes | — |
| `harness` | yes | — | — |
| `inputs` | yes | — | — |
| `insertArtifact` | — | yes | — |
| `instanceId` | opt | yes | — |
| `log` | — | — | yes |
| `meta` | yes | — | — |
| `model` | — | yes | yes |
| `moveName` | yes | yes | — |
| `moves` | — | — | yes |
| `notify` | — | yes | — |
| `pluginSettings` | yes | yes | yes |
| `run` | yes | — | — |
| `schema` | opt | — | — |
| `secrets` | yes | yes | yes |
| `self` | — | — | yes |
| `sendMessage` | — | yes | — |
| `session` | yes | — | — |
| `sessionId` | yes | yes | — |
| `sessions` | — | — | yes |
| `setStore` | opt | yes | — |
| `shell` | — | yes | yes |
| `state` | opt | yes | yes |
| `store` | opt | yes | — |
| `terminal` | — | — | yes |
| `token` | opt | — | — |
| `triggerAction` | — | yes | — |
| `userProfile` | yes | — | — |
| `vault` | — | yes | yes |
| `wake` | — | yes | — |
| `watchSessionTurns` | — | yes | — |

### Only on `MoveContext`

Not reachable from an API op handler: `apiToken`, `date`, `harness`, `inputs`, `meta`, `run`, `schema`, `session`, `token`, `userProfile`.

### Only on `MoveApiContext`

Not reachable from `gather()`/`onSubmit()`: `activateMove`, `caller`, `channels`, `createSession`, `emit`, `insertArtifact`, `model`, `notify`, `sendMessage`, `shell`, `triggerAction`, `vault`, `wake`, `watchSessionTurns`.

## Contexts

### `MoveContext` — passed to a move's `gather()` and `onSubmit()`

`harness/move-types.ts`

```ts
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
```

### `MoveApiContext` — passed to a move's API op handlers (what `modus_submit` reaches)

`harness/move-types.ts`

```ts
/** Context passed to move API handlers on each op call */
export interface MoveApiContext {
  instanceId: string;
  sessionId: string;
  moveName: string;
  /** Process identity boundary. Distinct from the move's `instanceId`. */
  vault: HarnessContext["vault"];
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
```

### `HarnessContext` — the canonical server-side capability contract the others are sourced from

`harness/harness-context.ts`

```ts
/** The unified context passed to all server-side extension code. */
export interface HarnessContext {
  self: HarnessSelf;
  /** Process identity boundary. Null is the implicit default Vault. */
  vault: { slug: string | null };
  sessions: HarnessSessions;
  channels: HarnessChannels;
  moves: HarnessMoves;
  actions: HarnessActions;
  model: HarnessModel;
  state: MoveStateAPI;
  db: MoveDB;
  secrets: MoveSecrets;
  shell: { run(cmd: string): Promise<string> };
  artifacts: HarnessArtifacts;
  terminal: HarnessTerminalApi;
  pluginSettings: {
    get<T = unknown>(key: string): T | undefined;
    all(): Record<string, unknown>;
  };
  log(message: string, metadata?: Record<string, unknown>): void;
}
```

## Supporting types

### `CodeActionContext` — passed to an isolated Code action's run(ctx)

`harness/action-operation-types.ts`

```ts
/** Only these operations cross the worker boundary; no harness internals are imported. */
export interface CodeActionContext {
  runId: number;
  actionName: string;
  inputs: Record<string, unknown>;
  trigger: { type: string; payload?: unknown; source?: string };
  cwd: string;
  signal: AbortSignal;
  log(message: string): void;
  process: {
    run(options: { executable: string; args?: string[]; cwd?: string; check?: boolean }): Promise<ProcessResult>;
  };
  artifacts: { path(filename: string): string };
  secrets: { resolve(reference: string): Promise<string | undefined> };
  actions: { trigger(name: string, inputs?: Record<string, unknown>): Promise<void> };
  sessions: { create(options: { profile: string; prompt: string }): Promise<unknown> };
}
```

### `CodeActionModule` — the Code action execution export

`harness/action-operation-types.ts`

```ts
export interface CodeActionModule {
  run(ctx: CodeActionContext): Promise<OperationResult | void>;
}
```

### `ActionInputSchema` — shared invocation input validation and forms

`harness/action-operation-types.ts`

```ts
/** Deliberately small JSON Schema subset shared by all invocation surfaces. */
export type ActionInputSchema = {
  type: "object";
  properties: Record<string, ActionInputField>;
  required?: string[];
  additionalProperties?: false;
};
```

### `OperationReceipt` — durable Command/Code run metadata

`harness/action-operation-types.ts`

```ts
export type OperationReceipt = {
  version: 1;
  runId: number;
  parentRunId?: number;
  caller: string;
  fingerprint: string;
  target: "backend";
  cwd: string;
  inputs: Record<string, unknown>;
  command?: { executable: string; args: string[]; shell: boolean };
  outcome: "running" | "succeeded" | "failed" | "could-not-start" | "timed-out" | "cancelled" | "interrupted" | "skipped";
  exitCode?: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  result?: OperationResult;
};
```

### `MoveApiHandler` — the handler signature

`harness/move-types.ts`

```ts
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
```

### `MoveToolViewDeclaration` — the `toolView` field in move.json

`harness/move-types.ts`

```ts
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
```

### `MoveToolViewProps` — passed to a move's transcript tool-view component

`harness/ui/src/move-tool-view.ts`

```ts
/** Props passed to a move's declared tool-view component. */
export type MoveToolViewProps = {
  moveName: string;
  instanceId: string;
  apiToken: string;
  sessionId: string;
  op: string;
  input: Record<string, unknown>;
  result?: MoveApiClientResult;
  /**
   * Whether `result` is trustworthy yet.
   *
   * `result` being undefined is ambiguous on its own — the call may still be
   * running, or the turn's details may have been deferred for transport and not
   * loaded back. Views that guessed rendered a hard error for what was really a
   * loading state. The substrate knows the difference, so it says which.
   *
   * The op arguments are in `input`, which is part of the tool call itself and
   * survives every transport; prefer it over `result` for anything needed to
   * paint before the call completes.
   */
  resultState: "pending" | "ready";
  /** Reserved for the immutable per-call record contract planned for v2. */
  record?: unknown;
  artifacts?: SessionArtifact[];
  status: ToolCall["status"];
  isLatest: boolean;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  callOp: (op: string, data?: Record<string, unknown>) => Promise<MoveApiClientResult>;
  submitMessage: (prompt: string) => Promise<void>;
  subscribe?: (listener: (event: { type: string; payload?: Record<string, unknown> }) => void) => () => void;
};
```

### `MoveCapabilities` — the capability gates a move declares

`harness/move-types.ts`

```ts
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
```

### `MoveStateAPI` — `ctx.state`

`harness/move-types.ts`

```ts
/** State API for move handlers — abstracts in-memory vs persisted storage */
export interface MoveStateAPI {
  get<T = unknown>(): Promise<T | undefined>;
  set(value: unknown): Promise<void>;
  delete(): Promise<void>;
}
```

### `MoveDB` — `ctx.db`

`harness/move-types.ts`

```ts
export interface MoveDB {
  listSessions(limit?: number): SessionRef[];
  getSession(id: string): SessionRef | null;
  searchSessions(query: string, limit?: number): SearchRef[];
  getMoveHistory(moveName: string, limit?: number): MoveRun[];
  /** Get structured message content (user/assistant turns) for a session. */
  getSessionMessages(sessionId: string): TurnContent[];
}
```

### `MoveSecrets` — `ctx.secrets`

`harness/move-types.ts`

```ts
export interface MoveSecrets {
  /** Resolve a secret by name. Checks secrets file first, then process.env. */
  resolve: (name: string) => string | undefined;
  /** Check if a secret is configured without exposing the value. */
  isSet: (name: string) => boolean;
}
```

### `HarnessBridge` — `ctx.harness` on MoveContext

`harness/move-types.ts`

```ts
export interface HarnessBridge {
  /** Process identity boundary. Null is the implicit default Vault. */
  vault: HarnessContext["vault"];
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
```

### `HarnessSelf` — `ctx.self` — identity and trust tier

`harness/harness-context.ts`

```ts
/** Who is calling, plus the gating inputs. Built by each adapter from its own origin. */
export interface HarnessSelf {
  kind: "move" | "action" | "api-handler" | "mission";
  name: string;
  sessionId: string | null;
  caller: "agent" | "user" | "system";
  cwd: string;
  userProfile?: string;
  /** Set when the authored caller came from an enabled Modus plugin. */
  pluginId?: string;
  trust: HarnessTrust;
  capabilities?: HarnessCapabilities;
  /** Instance-scoped state binding (api/persistent moves). When present, ctx.state is wired. */
  instanceId?: string;
  /** State persistence flag for the bound instance. */
  statePersist?: boolean;
}
```

### `HarnessSessions` — `ctx.sessions`

`harness/harness-context.ts`

```ts
export interface HarnessSessions {
  create(opts: { profile: string; prompt: string; cwd?: string; userProfile?: string; tags?: string[] }): Promise<string>;
  send(sessionId: string, content: string): Promise<void>;
  /** Deliver a message to a session id or tag now, or on a schedule (at/every/onEvent). */
  wake(target: string, content: string, when?: WakeWhen): Promise<WakeHandle>;
  watchTurns(sessionId: string, onTurn: (turn: TurnContent) => void | Promise<void>): () => void;
  tag(sessionId: string, tag: string): Promise<void>;
  untag(sessionId: string, tag: string): Promise<void>;
  get(id: string): SessionRef | null;
  list(limit?: number): SessionRef[];
}
```

### `HarnessChannels` — `ctx.channels` — the egress primitive

`harness/harness-context.ts`

```ts
export interface HarnessChannels {
  /** Send arbitrary content to a named channel (Discord/Slack/file). The egress primitive. */
  send(channel: string, payload: { text: string; data?: Record<string, unknown> }): Promise<ChannelResult>;
}
```

### `HarnessMoves` — `ctx.moves`

`harness/harness-context.ts`

```ts
export interface HarnessMoves {
  activate(opts: {
    moveName: string;
    inputs?: Record<string, unknown>;
    sessionId?: string;
    modeOverride?: "inline" | "branch" | "background";
  }): Promise<{ token: string; mode: string; spawnedSessionId?: string; prompt?: string; requiresDispatch: boolean; moveRunId: number }>;
  list(): MoveConfig[];
}
```

### `HarnessActions` — `ctx.actions`

`harness/harness-context.ts`

```ts
export interface HarnessActions {
  trigger(name: string, inputs?: Record<string, unknown>): Promise<void>;
}
```

### `HarnessArtifacts` — `ctx.artifacts`

`harness/harness-context.ts`

```ts
export interface HarnessArtifacts {
  insert(opts: { sessionId: string; name: string; mime: string; path: string; seq?: number; previewText?: string; metadata?: Record<string, unknown> }): number;
  attach(opts: { sessionId: string; seq: number; targetMessageUuid?: string; path: string; name: string; mime: string; previewText?: string; metadata?: Record<string, unknown> }): { id: number; sessionId: string; seq: number; name: string; mime: string; url: string; createdAt: number };
}
```

### `HarnessTerminalApi` — `ctx.terminal`

`harness/harness-context.ts`

```ts
export interface HarnessTerminalApi {
  create(opts?: { cwd?: string; shell?: string; cols?: number; rows?: number; env?: Record<string, string> }): ActionTerminalHandle;
}
```

### `WakeWhen` — the `wake()` schedule argument

`harness/harness-context.ts`

```ts
export type WakeWhen =
  | "now"
  | { at: string }            // ISO timestamp — one-shot
  | { every: string }         // "30m", "1h" — recurring
  | { onEvent: SessionTriggerEvent };
```

### `WakeHandle` — what `wake()` returns

`harness/harness-context.ts`

```ts
export interface WakeHandle {
  id: string;
  scheduled: boolean;
  /** Session ids delivered to (immediate "now" wakes only). */
  delivered?: string[];
  /** Cancel a scheduled wake. No-op for immediate wakes. */
  cancel(): void;
}
```

### `ChannelResult` — what `channels.send()` returns

`harness/harness-context.ts`

```ts
export type ChannelResult = { ok: boolean; error?: string };
```
