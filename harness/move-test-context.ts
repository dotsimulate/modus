/**
 * Test contexts for move authors.
 *
 * Move code receives a `MoveContext` (gather/onSubmit) or a `MoveApiContext`
 * (API op handlers). Both are assembled by move-runner from a live harness: a
 * database, a session, a capability gate, a token registry. None of that is
 * available to an author who just wants to check that a handler returns the
 * right shape, so the pattern everyone fell into was a lying cast —
 * `{ cwd } as MoveApiContext` — which compiles, hides every member the handler
 * actually touches, and fails at runtime with `undefined is not a function`.
 *
 * These factories return the real interface with no cast. Two consequences are
 * the point of the design:
 *
 *   1. Adding a member to `MoveContext`/`MoveApiContext` breaks this file at
 *      compile time, so the test surface cannot silently fall behind the
 *      production one. It is a maintained context, not a second mock contract.
 *   2. Anything that would reach a live harness — spawning a session, calling a
 *      model, triggering an action — throws by default, naming the member and
 *      how to override it. A handler that reaches for the network in a unit test
 *      fails loudly instead of quietly doing nothing.
 *
 * State, the process-scoped store, secrets and plugin settings are backed by
 * plain in-memory values, and every outbound call the handler makes is recorded
 * so a test can assert on it.
 *
 * Nothing here imports the database, the session manager, or the move runner, so
 * importing it starts no server and opens no handle.
 */

import type {
  HarnessBridge,
  MoveApiContext,
  MoveContext,
  MoveDB,
  MoveRun,
  MoveSecrets,
  MoveStateAPI,
  SearchRef,
  SessionRef,
} from "./move-types";
import type { TurnContent } from "./db";
import type { HarnessContext } from "./harness-context";

/** A call the move made back into the harness. */
export interface RecordedEvent {
  type: string;
  [key: string]: unknown;
}

export interface RecordedNotify {
  message: string;
  emit?: RecordedEvent;
}

export interface RecordedMessage {
  sessionId: string;
  message: string;
}

export interface TestContextOptions {
  /** Project working directory. Defaults to the process cwd; pass a temp dir for filesystem work. */
  cwd?: string;
  moveName?: string;
  sessionId?: string;
  instanceId?: string;
  /** Initial instance state. `ctx.state` reads and writes this in memory. */
  state?: unknown;
  /** Initial process-scoped store value. */
  store?: unknown;
  /** Secrets `ctx.secrets.resolve`/`isSet` will report. Nothing reads the real secrets file. */
  secrets?: Record<string, string>;
  /** Values returned by `ctx.pluginSettings`. */
  pluginSettings?: Record<string, unknown>;
  /** Partial read-only database. Unimplemented queries return empty results. */
  db?: Partial<MoveDB>;
}

export interface TestMoveApiContextOptions extends TestContextOptions {
  /** Who is calling the op. Handlers branch on this to decide what to inject. */
  caller?: "agent" | "user";
  /** Results for `ctx.shell.run`. Unstubbed commands throw, as in `createTestMoveContext`. */
  run?: (cmd: string) => Promise<string>;
  /**
   * Replace any member of the produced context — use this for the orchestration
   * members that throw by default, or to assert on a specific call.
   */
  overrides?: Partial<MoveApiContext>;
}

export interface TestMoveContextOptions extends TestContextOptions {
  userProfile?: string;
  /** Form inputs as the move would receive them from the composer. */
  inputs?: Record<string, unknown>;
  session?: Partial<MoveContext["session"]>;
  /** Shell results by command string, or a function. Unmatched commands throw. */
  run?: (cmd: string) => Promise<string>;
  overrides?: Partial<MoveContext>;
}

/** Everything a test needs to drive a move and inspect what it did. */
export interface TestMoveApiContextHandle {
  ctx: MoveApiContext;
  /** Events passed to `ctx.emit`, oldest first. */
  emitted: RecordedEvent[];
  /** Calls to `ctx.notify`, oldest first. */
  notified: RecordedNotify[];
  /** Calls to `ctx.sendMessage`, oldest first. */
  sentMessages: RecordedMessage[];
  /** Artifacts registered through `ctx.insertArtifact`, oldest first. */
  artifacts: Array<Parameters<MoveApiContext["insertArtifact"]>[0]>;
  /** Commands passed to `ctx.shell.run`, oldest first. */
  commands: string[];
  /** Current in-memory instance state. */
  currentState(): unknown;
  /** Current in-memory process-scoped store value. */
  currentStore(): unknown;
}

export interface TestMoveContextHandle {
  ctx: MoveContext;
  /** Metadata attached through `ctx.meta`. */
  meta: Record<string, unknown>;
  /** Commands passed to `ctx.run`, oldest first. */
  commands: string[];
  currentState(): unknown;
  currentStore(): unknown;
}

/**
 * Build a `MoveApiContext` for testing an op handler.
 *
 * ```ts
 * const { ctx, emitted, currentState } = createTestMoveApiContext({ cwd, state: { turns: 0 } });
 * const result = await handlers.play(ctx, { square: "e4" });
 * expect(result.ok).toBe(true);
 * expect(emitted.map((e) => e.type)).toEqual(["board"]);
 * ```
 */
export function createTestMoveApiContext(options: TestMoveApiContextOptions = {}): TestMoveApiContextHandle {
  const emitted: RecordedEvent[] = [];
  const notified: RecordedNotify[] = [];
  const sentMessages: RecordedMessage[] = [];
  const artifacts: Array<Parameters<MoveApiContext["insertArtifact"]>[0]> = [];
  const commands: string[] = [];
  const state = memoryState(options.state);
  const store = memoryStore(options.store);
  const moveName = options.moveName ?? "test-move";

  const ctx: MoveApiContext = {
    instanceId: options.instanceId ?? "test-instance",
    sessionId: options.sessionId ?? "test-session",
    moveName,
    cwd: options.cwd ?? process.cwd(),
    caller: options.caller ?? "agent",
    state: state.api,
    db: testMoveDb(options.db),
    secrets: testSecrets(options.secrets),
    pluginSettings: testPluginSettings(options.pluginSettings),
    emit: (event) => { emitted.push(event); },
    notify: (message, emit) => { notified.push(emit ? { message, emit } : { message }); },
    sendMessage: async (sessionId, message) => { sentMessages.push({ sessionId, message }); },

    // Orchestration. These reach a live harness in production, so a test that
    // hits one has either found a code path it did not mean to exercise or needs
    // to say what the call should return.
    shell: { run: testShellRun(moveName, options.run, "shell.run", "createTestMoveApiContext") },
    createSession: unavailableAsync(moveName, "createSession"),
    triggerAction: unavailableAsync(moveName, "triggerAction"),
    activateMove: unavailableAsync(moveName, "activateMove"),
    watchSessionTurns: unavailableSync(moveName, "watchSessionTurns"),
    wake: unavailableAsync(moveName, "wake"),
    channels: { send: unavailableAsync(moveName, "channels.send") },
    model: testModel(moveName),

    store: store.get,
    setStore: store.set,
    insertArtifact: (opts) => { artifacts.push(opts); return artifacts.length; },

    ...options.overrides,
  };

  // Record every command, including ones an override's shell handles.
  const declaredShell = ctx.shell;
  ctx.shell = {
    run: async (cmd) => {
      commands.push(cmd);
      return declaredShell.run(cmd);
    },
  };

  return {
    ctx,
    emitted,
    notified,
    sentMessages,
    artifacts,
    commands,
    currentState: state.current,
    currentStore: () => store.get(),
  };
}

/**
 * Build a `MoveContext` for testing `gather()`, `prepare()`, or `onSubmit()`.
 *
 * ```ts
 * const { ctx, meta } = createTestMoveContext({ cwd, inputs: { topic: "release" } });
 * const prompt = await gather(ctx);
 * expect(prompt).toContain("release");
 * ```
 */
export function createTestMoveContext(options: TestMoveContextOptions = {}): TestMoveContextHandle {
  const meta: Record<string, unknown> = {};
  const commands: string[] = [];
  const state = memoryState(options.state);
  const store = memoryStore(options.store);
  const moveName = options.moveName ?? "test-move";

  const ctx: MoveContext = {
    moveName,
    sessionId: options.sessionId ?? "test-session",
    session: {
      lastAssistantText: "",
      seq: 0,
      profile: undefined,
      exchangeCount: 0,
      ...options.session,
    },
    cwd: options.cwd ?? process.cwd(),
    userProfile: options.userProfile,
    inputs: options.inputs ?? {},
    db: testMoveDb(options.db),
    run: testShellRun(moveName, options.run, "run", "createTestMoveContext"),
    harness: testHarnessBridge(moveName),
    pluginSettings: testPluginSettings(options.pluginSettings),
    secrets: testSecrets(options.secrets),
    meta: (key, value) => { meta[key] = value; },

    // Set by move-runner before gather(); a move that reads one must be given it.
    token: undefined,
    schema: undefined,
    date: new Date().toISOString().slice(0, 10),
    apiToken: undefined,
    instanceId: options.instanceId ?? "test-instance",
    store: store.get,
    setStore: store.set,
    state: state.api,

    ...options.overrides,
  };

  // Record every command, including ones the caller's own `run` handles.
  const declaredRun = ctx.run;
  ctx.run = async (cmd) => {
    commands.push(cmd);
    return declaredRun(cmd);
  };

  return { ctx, meta, commands, currentState: state.current, currentStore: () => store.get() };
}

// ── in-memory backings ──

function memoryState(initial: unknown) {
  let value = initial;
  const api: MoveStateAPI = {
    get: async <T = unknown>() => value as T | undefined,
    set: async (next) => { value = next; },
    delete: async () => { value = undefined; },
  };
  return { api, current: () => value };
}

function memoryStore(initial: unknown) {
  let value = initial;
  return {
    get: <T = unknown>() => value as T | undefined,
    set: (next: unknown) => { value = next; },
  };
}

/**
 * Shell execution for a test context — `ctx.run` on a `MoveContext`,
 * `ctx.shell.run` on a `MoveApiContext`.
 *
 * An unstubbed command throws rather than returning an empty string. Shell is
 * the member most likely to have real side effects, so inventing output would
 * let a handler pass a test that never exercised the branch it claims to.
 */
function testShellRun(
  moveName: string,
  run: ((cmd: string) => Promise<string>) | undefined,
  member: string,
  factory: string,
): (cmd: string) => Promise<string> {
  if (run) return run;
  return async (cmd) => {
    throw new Error(
      `move "${moveName}" called ctx.${member}(${JSON.stringify(cmd)}) in a test context. ` +
        `Shell execution is not stubbed by default — pass \`run\` to ${factory} to decide what it returns.`,
    );
  };
}

function testSecrets(secrets: Record<string, string> | undefined): MoveSecrets {
  const values = secrets ?? {};
  return {
    resolve: (name) => values[name],
    isSet: (name) => values[name] !== undefined && values[name] !== "",
  };
}

function testPluginSettings(settings: Record<string, unknown> | undefined): HarnessContext["pluginSettings"] {
  const values = settings ?? {};
  return {
    get: <T = unknown>(key: string) => values[key] as T | undefined,
    all: () => ({ ...values }),
  };
}

/** Read-only queries default to empty rather than throwing: "no sessions yet" is a real state. */
function testMoveDb(db: Partial<MoveDB> | undefined): MoveDB {
  return {
    listSessions: (limit?: number): SessionRef[] => db?.listSessions?.(limit) ?? [],
    getSession: (id: string): SessionRef | null => db?.getSession?.(id) ?? null,
    searchSessions: (query: string, limit?: number): SearchRef[] => db?.searchSessions?.(query, limit) ?? [],
    getMoveHistory: (moveName: string, limit?: number): MoveRun[] => db?.getMoveHistory?.(moveName, limit) ?? [],
    getSessionMessages: (sessionId: string): TurnContent[] => db?.getSessionMessages?.(sessionId) ?? [],
  };
}

function testHarnessBridge(moveName: string): HarnessBridge {
  return {
    createSession: unavailableAsync(moveName, "harness.createSession"),
    sendMessage: unavailableAsync(moveName, "harness.sendMessage"),
    triggerAction: unavailableAsync(moveName, "harness.triggerAction"),
    notify: unavailableAsync(moveName, "harness.notify"),
    addSessionTag: unavailableAsync(moveName, "harness.addSessionTag"),
    listMoves: unavailableSync(moveName, "harness.listMoves"),
    activateMove: unavailableAsync(moveName, "harness.activateMove"),
    watchSessionTurns: unavailableSync(moveName, "harness.watchSessionTurns"),
    model: testModel(moveName),
  };
}

function testModel(moveName: string): HarnessContext["model"] {
  return {
    complete: unavailableAsync(moveName, "model.complete"),
    promote: unavailableAsync(moveName, "model.promote"),
    recent: unavailableSync(moveName, "model.recent"),
  };
}

function unavailableError(moveName: string, member: string): Error {
  return new Error(
    `move "${moveName}" called ctx.${member}() in a test context, which has no live harness. ` +
      `Pass an override for \`${member.split(".")[0]}\` to the test context factory to decide what it returns.`,
  );
}

/**
 * A promise-returning context member that would reach a live harness. It
 * *rejects* rather than throwing synchronously, because the production member
 * returns a promise and a move is entitled to `.catch()` it without awaiting —
 * a synchronous throw would escape that handler.
 *
 * Naming the member matters: the alternative, returning undefined, turns a
 * missing stub into a confusing failure somewhere else in the move.
 */
function unavailableAsync(moveName: string, member: string): any {
  return () => Promise.reject(unavailableError(moveName, member));
}

/** A synchronous context member that would reach a live harness. */
function unavailableSync(moveName: string, member: string): any {
  return () => { throw unavailableError(moveName, member); };
}
