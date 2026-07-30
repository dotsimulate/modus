/**
 * Move Runner — loads, activates, and processes moves.
 *
 * Moves are the user-facing invocation primitive:
 *   user invokes → gather context → render prompt → inject into session → agent submits → side effects
 *
 * Three execution modes:
 *   - inline:     message injected into current session, agent handles it now
 *   - branch:     spawn a sibling session with move prompt, return link
 *   - background: fire-and-forget session with persisted status
 *
 * Built-in harness moves live in `harness/moves/<name>/`.
 * Project-local moves live in `.modus/moves/<name>/` and override built-ins.
 *
 * Two token kinds, with different lifetimes: submit tokens are in-memory with a
 * TTL, while API tokens (`mapi-*`) never expire — their registration is
 * persisted per move and rehydrated after a restart.
 * Execution records are persisted to DB for recall.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import { APP_PATHS } from "./app-paths";
import type {
  MoveConfig, MoveModule, MoveContext, MoveToken,
  ActivateMoveOpts, ActivateMoveResult, SubmitResult,
  AttachMoveOpts, AttachMoveResult,
  MoveDB, HarnessBridge, MoveRun,
  MoveApiHandler, MoveApiContext, MoveApiRegistration, MoveStateAPI,
  AmbientMoveRegistration, MoveAssistantTurnContext,
  MoveCapabilities,
} from "./move-types";
import {
  type StartSessionOpts,
  broadcastUiEvent, getActiveSession, interactWithSession, startSession, stopSession, watchSessionExchanges,
} from "./session-manager";
import {
  listSessions as dbListSessions, listSessionsForProjects as dbListSessionsForProjects,
  getSession as dbGetSession,
  searchSessions as dbSearchSessions, getSessionMessages, insertSessionArtifact,
  listSessionCwds, sessionHasMoveContext,
  type TurnContent,
} from "./db";
import {
  insertMoveRun, updateMoveRun, getMoveRuns,
} from "./move-db";
import { logActivity } from "./activity";
import { resolveSecret, isSecretSet } from "./secrets";
import { addSessionTag as dbAddSessionTag } from "./db";
import { getPluginMovesDir, listEnabledModusPlugins } from "./modus-plugins";
import { buildHarnessContext, type HarnessSelf } from "./harness-context";
import { resolveProfileKey } from "./profiles";
import type { MoveSkillSource } from "./skill-attachment";

// ── Constants ──

const BUILTIN_MOVES_DIR = join(APP_PATHS.resourcesDir, "moves");
const MODUS_MOVES_DIR = ".modus/moves";
const DEFAULT_TTL_MS = 10 * 60_000;       // 10 minutes
const DEFAULT_MAX_ATTEMPTS = 3;
const TOKEN_CLEANUP_INTERVAL_MS = 60_000;  // sweep every 60s
// Persisted API registrations are pruned by age and count on write. Move API
// tokens themselves never expire — a session resumed days later must still be
// able to call its ops — so the only bound is this retention policy.
const MOVE_REGISTRY_RETENTION_DAYS = 30;
const MOVE_REGISTRY_RETAINED_COUNT = 200;
const GATHER_TIMEOUT_MS = 10_000;          // 10s default timeout for gather()
const ACTIVATE_GATHER_TIMEOUT_MS = 120_000; // 2min timeout for widget-first activate (user-triggered, may do heavy work)

/** Resolve the gather() timeout for a move — honors config.gatherTimeoutMs, else the fallback. */
function gatherTimeoutFor(config: MoveConfig | null | undefined, fallback = GATHER_TIMEOUT_MS): number {
  const t = config?.gatherTimeoutMs;
  return typeof t === "number" && t > 0 ? t : fallback;
}

/** Resolve the prepare() budget for a move — honors config.prepareTimeoutMs, else 120s. */
function prepareTimeoutFor(config: MoveConfig | null | undefined): number {
  const t = config?.prepareTimeoutMs;
  return typeof t === "number" && t > 0 ? t : ACTIVATE_GATHER_TIMEOUT_MS;
}

// ── Token Store (in-memory) ──

const tokenStore = new Map<string, MoveToken>();

// ── Process-scoped Instance Store ──
// Survives move module cache busts. Keyed by instanceId.
// Moves use store()/setStore() to persist orchestration state (trackers, watchers, etc.)
// across handler calls without relying on module-level Maps.
const instanceStore = new Map<string, unknown>();

export function getInstanceStore<T = unknown>(instanceId: string): T | undefined {
  return instanceStore.get(instanceId) as T | undefined;
}

export function setInstanceStore(instanceId: string, value: unknown): void {
  instanceStore.set(instanceId, value);
}

export function deleteInstanceStore(instanceId: string): void {
  instanceStore.delete(instanceId);
}

// Periodic cleanup of expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [key, tok] of tokenStore) {
    if (tok.status === "completed" || tok.status === "expired") {
      tokenStore.delete(key);
    } else if (now - tok.createdAt > tok.ttl) {
      tok.status = "expired";
      tokenStore.delete(key);
    }
  }
}, TOKEN_CLEANUP_INTERVAL_MS);

// ── Ambient Move Registry (persistent/gather-only moves) ──

/** sessionId → active ambient move registrations */
const ambientMoveRegistry = new Map<string, AmbientMoveRegistration[]>();

/** Register an ambient move for a session */
function registerAmbientMove(reg: AmbientMoveRegistration): void {
  const list = ambientMoveRegistry.get(reg.sessionId) ?? [];
  // Prevent duplicate registration of same move on same session
  if (list.some(r => r.moveName === reg.moveName)) return;
  list.push(reg);
  ambientMoveRegistry.set(reg.sessionId, list);
  console.log(`[move-runner] ambient registered: ${reg.moveName} on session ${reg.sessionId}`);
}

/** Deactivate an ambient move for a session. Returns true if found and removed. */
export function deactivateAmbientMove(sessionId: string, moveName: string): boolean {
  const list = ambientMoveRegistry.get(sessionId);
  if (!list) return false;
  const idx = list.findIndex(r => r.moveName === moveName);
  if (idx === -1) return false;
  const removed = list.splice(idx, 1)[0]!;
  if (list.length === 0) ambientMoveRegistry.delete(sessionId);
  // Clean up API registration if present. Drop the persisted row first, or the
  // token would be rehydrated on the next boot for a deactivated move.
  if (removed.apiToken) {
    dropPersistedMoveRegistration(removed.apiToken);
    moveApiRegistry.delete(removed.apiToken);
  }
  // Update DB record
  updateMoveRun(removed.moveRunId, { status: "completed", completedAt: Date.now() });
  logActivity({
    userProfile: removed.userProfile,
    eventType: "move_completed",
    sessionId,
    summary: `Ambient move deactivated: ${moveName}`,
    metadata: { moveName, persistent: true },
  });
  console.log(`[move-runner] ambient deactivated: ${moveName} on session ${sessionId}`);
  return true;
}

/** Get active ambient moves for a session */
export function getActiveAmbientMoves(sessionId: string): AmbientMoveRegistration[] {
  return ambientMoveRegistry.get(sessionId) ?? [];
}

/**
 * Gather ambient context for a session — called per-turn by session-manager.
 * Runs gather() for each active ambient move. Returns concatenated context
 * or null if no ambient moves produced output (all bailed or none active).
 */
export async function gatherAmbientContext(sessionId: string): Promise<string | null> {
  const moves = ambientMoveRegistry.get(sessionId);
  if (!moves || moves.length === 0) return null;

  const parts: string[] = [];
  const oneShotToRemove: string[] = [];

  for (const reg of moves) {
    try {
      const mod = await loadMoveModule(reg.moveName, reg.cwd);
      if (!mod?.gather) continue;

      const moveCfg = getMove(reg.moveName, reg.cwd);

      const ctx = buildMoveContext(reg.moveName, sessionId, reg.cwd, reg.userProfile, {
        inputs: reg.inputs,
        apiToken: reg.apiToken,
        instanceId: reg.instanceId,
      });

      const result = await Promise.race([
        mod.gather(ctx),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), gatherTimeoutFor(moveCfg))
        ),
      ]);

      // Gather-bail: null means skip this turn
      if (result === null) continue;

      let text = typeof result === "string" ? result : String(result);
      // Append modus_submit protocol for API moves
      if (reg.apiToken && moveCfg?.api?.ops) {
        text += buildApiOpsProtocol(reg.apiToken, moveCfg);
      }
      if (text.trim()) {
        parts.push(`<!-- ambient:${reg.moveName} -->\n${text}\n<!-- /ambient:${reg.moveName} -->`);
      }

      // Mark one-shot moves for removal after gather completes
      if (reg.oneShot) {
        oneShotToRemove.push(reg.moveName);
      }
    } catch (err) {
      console.error(`[move-runner] ambient gather failed for "${reg.moveName}":`, err);
    }
  }

  // Clean up one-shot ambient moves
  for (const name of oneShotToRemove) {
    deactivateAmbientMove(sessionId, name);
    console.log(`[move-runner] one-shot ambient deregistered: ${name} on session ${sessionId}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ── Move API Registry (api tokens → handlers) ──

const MAPI_PREFIX = "mapi-";

/** token → registration */
const moveApiRegistry = new Map<string, MoveApiRegistration>();

/** instanceId → state (in-memory) */
const moveApiState = new Map<string, unknown>();

type SessionTurnListener = {
  sessionId: string;
  onTurn: (turn: TurnContent) => void | Promise<void>;
};

/** sessionId → listenerKey → listener */
const sessionTurnListeners = new Map<string, Map<string, SessionTurnListener>>();

/** sessionId → session-manager unsubscribe */
const sessionTurnWatchers = new Map<string, () => void>();

/** apiToken → bound sessionId for move assistant hook cleanup/rebind */
const moveAssistantTurnBindings = new Map<string, string>();

/** Check if a token is a move-api token */
export function isMoveApiToken(token: string): boolean {
  return token.startsWith(MAPI_PREFIX);
}

/** Generate an instance ID */
function generateInstanceId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
}

function latestAssistantTurnForSession(sessionId: string, maxSeq: number, fallbackText?: string): TurnContent {
  const turns = getSessionMessages(sessionId);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    if (turn.role === "assistant" && turn.seq <= maxSeq) return turn;
  }
  return {
    role: "assistant",
    seq: maxSeq,
    text: fallbackText ?? "",
    timestamp: Date.now(),
  };
}

function ensureSessionTurnWatcher(sessionId: string): void {
  if (sessionTurnWatchers.has(sessionId)) return;
  const unsubscribe = watchSessionExchanges(sessionId, (payload) => {
    const listeners = sessionTurnListeners.get(sessionId);
    if (!listeners || listeners.size === 0) return;
    const turn = latestAssistantTurnForSession(sessionId, payload.seq, payload.lastResponse);
    for (const listener of listeners.values()) {
      Promise.resolve(listener.onTurn(turn)).catch((err) => {
        console.error(`[move-runner] session turn listener failed for ${sessionId}:`, err);
      });
    }
  });
  sessionTurnWatchers.set(sessionId, unsubscribe);
}

function registerSessionTurnListener(
  listenerKey: string,
  sessionId: string,
  onTurn: (turn: TurnContent) => void | Promise<void>,
): void {
  if (!sessionId) return;
  const listeners = sessionTurnListeners.get(sessionId) ?? new Map<string, SessionTurnListener>();
  listeners.set(listenerKey, { sessionId, onTurn });
  sessionTurnListeners.set(sessionId, listeners);
  ensureSessionTurnWatcher(sessionId);
}

function unregisterSessionTurnListener(listenerKey: string, sessionId: string): void {
  const listeners = sessionTurnListeners.get(sessionId);
  if (!listeners) return;
  listeners.delete(listenerKey);
  if (listeners.size > 0) return;
  sessionTurnListeners.delete(sessionId);
  const unsubscribe = sessionTurnWatchers.get(sessionId);
  if (unsubscribe) {
    unsubscribe();
    sessionTurnWatchers.delete(sessionId);
  }
}

export function watchMoveSessionTurns(
  sessionId: string,
  onTurn: (turn: TurnContent) => void | Promise<void>,
): () => void {
  const listenerKey = `adhoc:${generateToken()}`;
  registerSessionTurnListener(listenerKey, sessionId, onTurn);
  return () => unregisterSessionTurnListener(listenerKey, sessionId);
}

// ── Registry Persistence ──

type PersistedMoveRegistration = {
  instanceId: string;
  sessionId: string;
  cwd: string;
  createdAt: number;
  userProfile?: string;
  persistState?: boolean;
};

/** Read the _registry.json for a move's state directory */
function readMoveRegistry(cwd: string, moveName: string): Record<string, PersistedMoveRegistration> {
  const path = join(cwd, ".modus/moves", moveName, "state", "_registry.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Drop registrations that are older than the retention window or beyond the
 * retained count, newest first. Without this, every interactive activation of an
 * API move would leave a permanent row (each activation mints a new instanceId).
 */
function pruneMoveRegistry(
  registry: Record<string, PersistedMoveRegistration>,
  now = Date.now(),
): Record<string, PersistedMoveRegistration> {
  const maxAgeMs = MOVE_REGISTRY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = Object.entries(registry)
    .filter(([, entry]) => {
      const createdAt = typeof entry?.createdAt === "number" ? entry.createdAt : 0;
      // Legacy rows without a timestamp are kept — they predate this policy and
      // a live agent may still hold their token.
      return createdAt === 0 || now - createdAt <= maxAgeMs;
    })
    .sort((a, b) => (b[1]?.createdAt ?? 0) - (a[1]?.createdAt ?? 0))
    .slice(0, MOVE_REGISTRY_RETAINED_COUNT);
  return Object.fromEntries(kept);
}

/** Write the _registry.json for a move's state directory */
function writeMoveRegistry(cwd: string, moveName: string, registry: Record<string, unknown>): void {
  const dir = join(cwd, ".modus/moves", moveName, "state");
  mkdirSync(dir, { recursive: true });
  const pruned = pruneMoveRegistry(registry as Record<string, PersistedMoveRegistration>);
  writeFileSync(join(dir, "_registry.json"), JSON.stringify(pruned, null, 2));
}

/** Remove a token's persisted registration so it cannot be rehydrated later. */
function dropPersistedMoveRegistration(apiToken: string): void {
  const reg = moveApiRegistry.get(apiToken);
  if (!reg?.persistRegistration) return;
  const registry = readMoveRegistry(reg.cwd, reg.moveName);
  if (!registry[apiToken]) return;
  delete registry[apiToken];
  writeMoveRegistry(reg.cwd, reg.moveName, registry);
}

/** Create a move-api token and register handlers */
function registerMoveApi(
  moveName: string,
  instanceId: string,
  sessionId: string,
  cwd: string,
  handlers: Record<string, MoveApiHandler>,
  persist: boolean,
  userProfile?: string,
  inferOp?: (data: Record<string, unknown>) => string | null | undefined,
  // Declaring `api.ops` is enough to earn a persisted registration. Handler
  // state persistence (`persist`) is a separate opt-in: a stateless move still
  // needs its token to survive a harness restart, because the token is baked
  // into the session transcript and the agent may call it hours later.
  persistRegistration = true,
): string {
  const config = getMove(moveName, cwd);
  const prefix = config?.api?.tokenPrefix ?? moveName;
  const token = `${MAPI_PREFIX}${prefix}-${instanceId}`;

  moveApiRegistry.set(token, {
    moveName,
    instanceId,
    sessionId,
    cwd,
    userProfile,
    handlers,
    persist,
    persistRegistration,
    defaultOp: typeof config?.api?.defaultOp === "string" ? config.api.defaultOp : undefined,
    inferOp,
  });
  console.log(`[move-reg] registerMoveApi: sessionId=${sessionId} move=${moveName}`);

  // Initialize state if not already present (resume case)
  if (!moveApiState.has(instanceId)) {
    moveApiState.set(instanceId, undefined);
  }

  // Persist registration for restart survival. Profile-bound inline moves can
  // persist their capability registration without opting their handler state
  // into disk persistence.
  if (persistRegistration) {
    const registry = readMoveRegistry(cwd, moveName);
    registry[token] = {
      instanceId,
      sessionId,
      cwd,
      createdAt: Date.now(),
      userProfile,
      persistState: persist,
    };
    writeMoveRegistry(cwd, moveName, registry);
  }

  return token;
}

/** Build the state API for an instance — exported for use outside handler context (e.g. watcher callbacks) */
export function buildStateApi(instanceId: string, moveName: string, cwd: string, persist: boolean): MoveStateAPI {
  return {
    async get<T = unknown>(): Promise<T | undefined> {
      if (persist) {
        const path = join(cwd, ".modus/moves", moveName, "state", `${instanceId}.json`);
        try {
          const raw = readFileSync(path, "utf-8");
          return JSON.parse(raw) as T;
        } catch {
          return moveApiState.get(instanceId) as T | undefined;
        }
      }
      return moveApiState.get(instanceId) as T | undefined;
    },
    async set(value: unknown): Promise<void> {
      moveApiState.set(instanceId, value);
      if (persist) {
        const dir = join(cwd, ".modus/moves", moveName, "state");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${instanceId}.json`), JSON.stringify(value, null, 2));
      }
    },
    async delete(): Promise<void> {
      moveApiState.delete(instanceId);
      if (persist) {
        try {
          unlinkSync(join(cwd, ".modus/moves", moveName, "state", `${instanceId}.json`));
        } catch { /* already gone */ }
        // Remove from registry
        const registry = readMoveRegistry(cwd, moveName);
        for (const [tok, entry] of Object.entries(registry)) {
          if ((entry as any).instanceId === instanceId) delete registry[tok];
        }
        writeMoveRegistry(cwd, moveName, registry);
      }
    },
  };
}

async function syncMoveAssistantTurnListener(
  apiToken: string,
  mod: MoveModule | null | undefined,
): Promise<void> {
  const reg = moveApiRegistry.get(apiToken);
  const previousSessionId = moveAssistantTurnBindings.get(apiToken);
  if (previousSessionId && previousSessionId !== reg?.sessionId) {
    unregisterSessionTurnListener(apiToken, previousSessionId);
    moveAssistantTurnBindings.delete(apiToken);
  }

  if (!reg?.sessionId || !mod?.onAssistantTurn) return;

  registerSessionTurnListener(apiToken, reg.sessionId, async (assistantTurn) => {
    const active = getActiveSession(reg.sessionId);
    const ctx: MoveAssistantTurnContext = {
      instanceId: reg.instanceId,
      sessionId: reg.sessionId,
      moveName: reg.moveName,
      cwd: reg.cwd,
      userProfile: reg.userProfile,
      state: buildStateApi(reg.instanceId, reg.moveName, reg.cwd, reg.persist),
      session: {
        lastAssistantText: active?.lastAssistantText ?? assistantTurn.text,
        seq: active?.seq ?? assistantTurn.seq,
        profile: active?.profile,
        exchangeCount: active?.exchangeCount ?? 0,
      },
      assistant: assistantTurn,
      emit: (event) => {
        broadcastUiEvent(reg.sessionId, {
          type: "ui",
          action: "move-widget-event",
          moveName: reg.moveName,
          instanceId: reg.instanceId,
          apiToken,
          event,
        });
      },
    };
    await mod.onAssistantTurn!(ctx);
  });
  moveAssistantTurnBindings.set(apiToken, reg.sessionId);
}

function clearMoveAssistantTurnListener(apiToken: string): void {
  const sessionId = moveAssistantTurnBindings.get(apiToken);
  if (!sessionId) return;
  unregisterSessionTurnListener(apiToken, sessionId);
  moveAssistantTurnBindings.delete(apiToken);
}

/** Handle a move-api op call (called from modus-mcp.ts) */
export async function handleMoveApiSubmit(
  token: string,
  data: Record<string, unknown>,
  caller: "agent" | "user" = "agent",
): Promise<{ ok: boolean; message?: string; error?: string }> {
  // A missing registration is a lifecycle problem, not a caller mistake: these
  // tokens have no TTL. Try to recover it from disk before failing, then say
  // exactly what happened and how to get unstuck.
  const reg = moveApiRegistry.get(token) ?? await recoverMoveApiRegistration(token);
  if (!reg) {
    return {
      ok: false,
      error: [
        `Move API token is not registered: ${token}`,
        "",
        "This token did not expire — move API tokens have no lifetime. Its registration",
        "is missing, which means the move was detached, or it was activated by a harness",
        "process that did not persist the registration before exiting.",
        "",
        "Recovery: you cannot re-mint this yourself. Tell the user to re-invoke the move,",
        "then use the fresh token from the newly injected move context.",
      ].join("\n"),
    };
  }

  // llama.cpp autoparser wraps payload under data.op as an object instead of data.op being a string.
  // Pattern 1: {op: {op: "name", ...params}} — inner op preserved, unwrap directly
  // Pattern 2: {op: {field: val, ...}} — op name lost, infer from registered handlers
  if (typeof data.op === "object" && data.op !== null) {
    const inner = data.op as Record<string, unknown>;
    if (typeof inner.op === "string") {
      data = inner;
    } else {
      const handlerNames = Object.keys(reg.handlers);
      if (handlerNames.length === 1) {
        data = { op: handlerNames[0], ...inner };
      } else if (reg.defaultOp && handlerNames.includes(reg.defaultOp)) {
        data = { op: reg.defaultOp, ...inner };
      }
    }
  }

  if (typeof data.op !== "string" && reg.inferOp) {
    try {
      const inferred = reg.inferOp(data);
      if (typeof inferred === "string" && inferred.length > 0) data = { ...data, op: inferred };
    } catch {}
  }

  const op = data.op;
  if (typeof op !== "string") {
    const available = Object.keys(reg.handlers).join(", ");
    return { ok: false, error: `Missing 'op' field. Available ops: ${available}` };
  }

  const handler = reg.handlers[op];
  if (!handler) {
    return { ok: false, error: `Unknown op: ${op}` };
  }

  const stateApi = buildStateApi(reg.instanceId, reg.moveName, reg.cwd, reg.persist);

  // Harness Context backs the orchestration-parity methods (createSession, triggerAction,
  // activateMove, watchSessionTurns, channels). The historic fields below (notify session-inject,
  // sendMessage, state, db, …) are kept exactly as-is — only additive parity is gained.
  const handlerCfg = getMove(reg.moveName, reg.cwd);
  const handlerSelf: HarnessSelf = {
    kind: "move",
    name: reg.moveName,
    sessionId: reg.sessionId || null,
    caller,
    cwd: reg.cwd,
    userProfile: reg.userProfile,
    pluginId: handlerCfg?.pluginId,
    trust: resolveTrust(handlerCfg ?? undefined),
    capabilities: handlerCfg?.capabilities ?? {},
    instanceId: reg.instanceId,
    statePersist: reg.persist,
  };
  const hctx = buildHarnessContext(handlerSelf);

  const ctx: MoveApiContext = {
    instanceId: reg.instanceId,
    sessionId: reg.sessionId,
    moveName: reg.moveName,
    cwd: reg.cwd,
    caller,
    state: stateApi,
    db: buildMoveDB(reg.moveName, reg.cwd),
    secrets: {
      resolve: (name: string) => resolveSecret(name),
      isSet: (name: string) => isSecretSet(name),
    },
    pluginSettings: hctx.pluginSettings,
    store: <T = unknown>() => instanceStore.get(reg.instanceId) as T | undefined,
    setStore: (value: unknown) => { instanceStore.set(reg.instanceId, value); },
    insertArtifact: (opts) => {
      return insertSessionArtifact({
        sessionId: opts.sessionId,
        seq: opts.seq ?? 0,
        name: opts.name,
        mime: opts.mime,
        path: opts.path,
        previewText: opts.previewText,
        metadata: opts.metadata,
      });
    },
    notify: (message: string, emit?: { type: string; [key: string]: unknown }) => {
      if (caller === "user") {
        if (emit) {
          broadcastUiEvent(reg.sessionId, {
            type: "ui",
            action: "move-widget-event",
            moveName: reg.moveName,
            instanceId: reg.instanceId,
            apiToken: token,
            event: emit,
          });
        }
        logActivity({
          eventType: "move_handler_notify",
          sessionId: reg.sessionId || undefined,
          summary: `${reg.moveName}:${op} notify [user/ui-only] -> ${message.slice(0, 80)}`,
          metadata: { moveName: reg.moveName, op, emitType: emit?.type, caller },
        });
        return;
      }
      const injected = emit
        ? `[modus:${emit.type}] ${JSON.stringify(emit)}\n${message}`.trim()
        : message;
      void interactWithSession({
        sessionId: reg.sessionId,
        prompt: injected,
        cwd: reg.cwd,
        createIfMissing: false,
      }).catch((err) => {
        console.error(`[move-runner] notify failed for ${reg.moveName} on session ${reg.sessionId}:`, err);
      });
      // ── Audit: log handler notify (message injection) ──
      logActivity({
        eventType: "move_handler_notify",
        sessionId: reg.sessionId || undefined,
        summary: `${reg.moveName}:${op} notify → ${message.slice(0, 80)}`,
        metadata: { moveName: reg.moveName, op, emitType: emit?.type },
      });
    },
    sendMessage: async (targetSessionId: string, message: string) => {
      await interactWithSession({
        sessionId: targetSessionId,
        prompt: message,
        cwd: reg.cwd,
        createIfMissing: false,
      });
      logActivity({
        eventType: "move_send_message",
        sessionId: reg.sessionId || undefined,
        summary: `${reg.moveName} → session ${targetSessionId}: ${message.slice(0, 80)}`,
        metadata: {
          moveName: reg.moveName,
          targetSessionId,
          contentLength: message.length,
          source: "move_api",
        },
      });
    },

    // ── Orchestration parity (Harness Context-backed) ──
    createSession: (opts) => hctx.sessions.create(opts),
    triggerAction: (actionName) => hctx.actions.trigger(actionName),
    activateMove: (opts) => hctx.moves.activate(opts),
    watchSessionTurns: (targetSessionId, onTurn) => hctx.sessions.watchTurns(targetSessionId, onTurn),
    wake: (target, content, when) => hctx.sessions.wake(target, content, when),
    channels: hctx.channels,
    model: hctx.model,
  };

  // Pass the inner data payload to the handler, not the full {op, data} envelope.
  // Agents may send {op: "log", data: {message: "..."}} or flat {op: "log", message: "..."}.
  const payload = (typeof data.data === "object" && data.data !== null)
    ? data.data as Record<string, unknown>
    : data;
  const result = await handler(ctx, payload);

  // ── Audit: log every op call ──
  logActivity({
    eventType: "move_op",
    sessionId: reg.sessionId || undefined,
    summary: `${reg.moveName}:${op} [${caller}] → ${result.ok ? "ok" : "error"}`,
    metadata: {
      moveName: reg.moveName,
      op,
      caller,
      instanceId: reg.instanceId,
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    },
  });

  return result;
}

/** List active instances for a move (for {{openInstances}} template var resolution) */
export function listMoveApiInstances(moveName: string): Array<{ instanceId: string; state: unknown }> {
  const instances: Array<{ instanceId: string; state: unknown }> = [];
  for (const [, reg] of moveApiRegistry) {
    if (reg.moveName === moveName) {
      instances.push({ instanceId: reg.instanceId, state: moveApiState.get(reg.instanceId) });
    }
  }
  return instances;
}

/** Update all move registry entries that reference oldSessionId to use newSessionId */
export function rekeyMoveRegistrySession(oldSessionId: string, newSessionId: string): void {
  let matched = 0;
  for (const [token, reg] of moveApiRegistry) {
    if (reg.sessionId === oldSessionId) {
      reg.sessionId = newSessionId;
      if (reg.persistRegistration) {
        const registry = readMoveRegistry(reg.cwd, reg.moveName);
        const entry = registry[token];
        if (entry) {
          entry.sessionId = newSessionId;
          writeMoveRegistry(reg.cwd, reg.moveName, registry);
        }
      }
      void loadMoveModule(reg.moveName, reg.cwd).then((mod) => syncMoveAssistantTurnListener(token, mod));
      matched++;
      console.log(`[move-reg] rekey: move=${reg.moveName} ${oldSessionId} → ${newSessionId}`);
    }
  }
  if (matched === 0) {
    console.log(`[move-reg] rekey: NO MATCH for oldSessionId=${oldSessionId} (registry has ${moveApiRegistry.size} entries: ${[...moveApiRegistry.values()].map(r => r.sessionId).join(", ")})`);
  }
}

/** Rekey a specific move registration by its apiToken — precise, no sessionId guessing */
export function rekeyMoveByToken(apiToken: string, newSessionId: string): boolean {
  const reg = moveApiRegistry.get(apiToken);
  if (!reg) {
    console.log("[move-reg] rekey-by-token: unknown capability");
    return false;
  }
  const oldSessionId = reg.sessionId;
  reg.sessionId = newSessionId;
  if (reg.persistRegistration) {
    const registry = readMoveRegistry(reg.cwd, reg.moveName);
    const entry = registry[apiToken];
    if (entry) {
      entry.sessionId = newSessionId;
      writeMoveRegistry(reg.cwd, reg.moveName, registry);
    }
  }
  void loadMoveModule(reg.moveName, reg.cwd).then((mod) => syncMoveAssistantTurnListener(apiToken, mod));
  console.log(`[move-reg] rekey-by-token: move=${reg.moveName} ${oldSessionId} → ${newSessionId}`);
  return true;
}

/** Get all active move widgets for a session */
export function getActiveWidgetForSession(sessionId: string): Array<{
  widget: { label: string; icon?: string; autoOpen?: boolean; cache?: string; moduleUrl: string; moveName: string };
  apiToken: string;
  instanceId: string;
}> {
  const results: Array<{ widget: { label: string; icon?: string; autoOpen?: boolean; mountOnAttach?: boolean; cache?: string; moduleUrl: string; moveName: string }; apiToken: string; instanceId: string }> = [];
  for (const [token, reg] of moveApiRegistry) {
    if (reg.sessionId === sessionId) {
      const config = getMove(reg.moveName, reg.cwd);
      if (config?.widget?.component) {
        results.push({
          widget: {
            label: config.widget.label ?? reg.moveName,
            icon: config.widget.icon,
            autoOpen: config.widget.autoOpen,
            mountOnAttach: config.widget.mountOnAttach,
            cache: config.widget.cache,
            moduleUrl: `/api/moves/${reg.moveName}/widget?cwd=${encodeURIComponent(reg.cwd)}`,
            moveName: reg.moveName,
          },
          apiToken: token,
          instanceId: reg.instanceId,
        });
      }
    }
  }
  return results;
}

// ── Move Loading ──

function projectMovesDir(cwd: string): string {
  return join(cwd, MODUS_MOVES_DIR);
}

export function resolveMoveLocation(name: string, cwd: string): {
  dir: string;
  origin: "harness" | "project" | "plugin";
  pluginId?: string;
  pluginPath?: string;
} | null {
  const projectDir = join(projectMovesDir(cwd), name);
  if (existsSync(join(projectDir, "move.json"))) {
    return { dir: projectDir, origin: "project" };
  }

  for (const plugin of listEnabledModusPlugins()) {
    const pluginDir = join(getPluginMovesDir(plugin), name);
    if (existsSync(join(pluginDir, "move.json"))) {
      return {
        dir: pluginDir,
        origin: "plugin",
        pluginId: plugin.id,
        pluginPath: plugin.path,
      };
    }
  }

  const builtinDir = join(BUILTIN_MOVES_DIR, name);
  if (existsSync(join(builtinDir, "move.json"))) {
    return { dir: builtinDir, origin: "harness" };
  }

  return null;
}

/**
 * Move locations plus their declared skill names, for skill attachment.
 * Lives here because it needs move resolution; `skill-attachment.ts` stays a
 * leaf and takes these as input rather than importing the move runner.
 * Unresolvable moves are skipped — move activation reports those separately.
 */
export function getMoveSkillSources(moves: { name: string }[], cwd: string): MoveSkillSource[] {
  const sources: MoveSkillSource[] = [];
  const seen = new Set<string>();
  for (const binding of moves) {
    if (seen.has(binding.name)) continue;
    seen.add(binding.name);
    const location = resolveMoveLocation(binding.name, cwd);
    if (!location) continue;
    sources.push({
      name: binding.name,
      dir: location.dir,
      skills: getMove(binding.name, cwd)?.skills,
    });
  }
  return sources;
}

/** Load a single move config from disk */
export function getMove(name: string, cwd: string): MoveConfig | null {
  const location = resolveMoveLocation(name, cwd);
  if (!location) return null;
  const configPath = join(location.dir, "move.json");
  try {
    const raw = readFileSync(configPath, "utf-8");
    const config: MoveConfig = JSON.parse(raw);
    config.name = name; // enforce directory name as canonical
    config.origin = location.origin;
    config.pluginId = location.pluginId;
    config.pluginPath = location.pluginPath;
    return config;
  } catch (err) {
    console.error(`[move-runner] Failed to load move "${name}":`, err);
    return null;
  }
}

/**
 * Build modus_submit protocol instructions for an API move.
 * Appended to gather output so the agent knows how to call ops.
 * The move author should NOT need to explain this — the harness owns the protocol.
 */
function buildApiOpsProtocol(apiToken: string, config: MoveConfig): string {
  if (!config.api?.ops) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("## How to call ops");
  lines.push("");
  lines.push("Use the `modus_submit` tool:");
  lines.push("```");
  lines.push(`modus_submit({ token: "${apiToken}", data: { "op": "<op-name>", "field": "value", "field2": "value2" } })`);
  lines.push("```");
  lines.push("");
  lines.push("Do NOT use Bash, curl, or raw HTTP. Always use `modus_submit`.");
  lines.push("");
  lines.push("Available ops:");
  for (const [opName, opDecl] of Object.entries(config.api.ops)) {
    lines.push(`- \`${opName}\` — ${opDecl.description}`);
    if (opDecl.schema && (opDecl.schema as any).properties) {
      const props = (opDecl.schema as any).properties as Record<string, any>;
      const required = new Set((opDecl.schema as any).required ?? []);
      for (const [param, info] of Object.entries(props)) {
        const req = required.has(param) ? " (required)" : "";
        const desc = info.description ?? "";
        lines.push(`  - \`${param}\`${req}: ${desc}`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Run a move's gather() once and return the prompt text.
 * Used by action-runner to prepend move context to action prompts.
 * Returns null if the move doesn't exist, has no gather(), or gather bails.
 *
 * For API moves (moves with ops + handlers), registers the handlers and
 * passes the apiToken to gather() so the agent can call ops via modus_submit.
 */
export async function gatherMoveOnce(
  moveName: string,
  sessionId: string,
  cwd: string,
  userProfile: string | undefined,
  inputs: Record<string, unknown>,
  opts?: { persistApiRegistration?: boolean },
): Promise<{ text: string; apiToken?: string } | null> {
  const mod = await loadMoveModule(moveName, cwd);
  if (!mod?.gather) {
    console.warn(`[gatherMoveOnce] move "${moveName}" has no gather() export — skipping`);
    return null;
  }

  const config = getMove(moveName, cwd);
  let apiToken: string | undefined;
  let instanceId: string | undefined;

  // Register API handlers if this move declares ops and has handlers
  if (config?.api?.ops && mod.handlers) {
    instanceId = generateInstanceId();
    apiToken = registerMoveApi(
      moveName,
      instanceId,
      sessionId,
      cwd,
      mod.handlers,
      config.api.state?.persist ?? false,
      userProfile,
      mod.inferOp,
      opts?.persistApiRegistration,
    );
    await syncMoveAssistantTurnListener(apiToken, mod);
  }

  // Generate submit token + schema if the move uses submit
  const needsSubmit = config?.submit?.required !== false && config?.submit;
  const token = needsSubmit ? generateToken() : undefined;
  const schema = config?.schemaHint ?? (config?.schema ? JSON.stringify(config.schema, null, 2) : undefined);

  // Shared metadata bag — gather() populates via ctx.meta()
  const gatheredContext: Record<string, unknown> = {};

  const ctx = buildMoveContext(moveName, sessionId, cwd, userProfile, {
    inputs, apiToken, instanceId, token, schema, metadata: gatheredContext,
  });

  // Wire up store/setStore for API moves
  if (instanceId) {
    ctx.store = <T = unknown>() => instanceStore.get(instanceId!) as T | undefined;
    ctx.setStore = (value: unknown) => { instanceStore.set(instanceId!, value); };
  }

  const gatherTimeout = gatherTimeoutFor(config);
  const gatherStart = Date.now();
  const result = await Promise.race([
    mod.gather(ctx),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), gatherTimeout)),
  ]);
  if (result === null) {
    console.warn(`[gatherMoveOnce] move "${moveName}" gather returned null (took ${Date.now() - gatherStart}ms, timeout=${gatherTimeout}ms)`);
    return null;
  }
  const text = typeof result === "string" ? result : String(result);
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Register submit token in store so modus_submit can find it
  if (token && config) {
    const moveRunId = insertMoveRun({
      moveName,
      sessionId,
      mode: "inline",
      status: "pending",
      inputs: JSON.stringify(inputs),
      gatheredContext: JSON.stringify(gatheredContext),
      token,
    });

    const moveToken: MoveToken = {
      token,
      sessionId,
      moveName,
      mode: "inline",
      schema: config.schema,
      inputs,
      gatheredContext,
      cwd,
      userProfile,
      createdAt: Date.now(),
      ttl: DEFAULT_TTL_MS,
      status: "pending",
      attempts: 0,
      maxAttempts: config.submit?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      moveRunId,
      spawnedSessionId: null,
      apiToken,
      instanceId,
    };
    tokenStore.set(token, moveToken);

    logActivity({
      userProfile,
      eventType: "move_activated",
      sessionId: sessionId || undefined,
      summary: `Move gathered (inline): ${config.label ?? moveName}`,
      metadata: { moveName, mode: "inline", token, ...(apiToken ? { apiToken, instanceId } : {}) },
    });
  }

  // Append modus_submit protocol for API moves
  const opsProtocol = (apiToken && config?.api?.ops) ? buildApiOpsProtocol(apiToken, config) : "";
  return { text: trimmed + opsProtocol, apiToken };
}

// ── Profile/Action Move Binding ──

export type MoveBindingSpec = { name: string; inputs?: Record<string, unknown> };

export type MoveBindingResult = {
  /** Text to prepend to the initial prompt (from inline/non-persistent gathers) */
  inlineContext: string | null;
  /** API tokens that need rekeying once the real session ID is known */
  apiTokens: string[];
  /** Persistent moves that were activated (for logging) */
  activatedPersistent: string[];
};

/**
 * Activate move bindings for a session. Shared by session-manager (profile moves)
 * and action-runner (action moves).
 *
 * Phase 1 (pre-spawn): call with sessionId="" to gather inline (non-persistent) moves.
 *   Returns inlineContext to prepend to prompt + apiTokens to rekey after spawn.
 *
 * Phase 2 (post-spawn): call with real sessionId to activate persistent/ambient moves.
 *   Pass `persistentOnly: true` to skip inline moves (already gathered in phase 1).
 */
export async function activateMoveBindings(
  moves: MoveBindingSpec[],
  sessionId: string,
  cwd: string,
  userProfile: string | undefined,
  opts?: {
    persistentOnly?: boolean;
    logPrefix?: string;
    /** Logical session whose already-recorded inline move blocks must not be injected again. */
    skipPreviouslyInjectedForSession?: string;
    /** Keep inline API capabilities alive across a harness restart. */
    persistInlineApiRegistrations?: boolean;
  },
): Promise<MoveBindingResult> {
  const prefix = opts?.logPrefix ?? "move-bindings";
  const result: MoveBindingResult = { inlineContext: null, apiTokens: [], activatedPersistent: [] };
  const inlineParts: string[] = [];

  for (const spec of moves) {
    const moveCfg = getMove(spec.name, cwd);
    if (!moveCfg) {
      console.warn(`[${prefix}] move "${spec.name}" not found, skipping`);
      continue;
    }

    if (moveCfg.persistent) {
      // Persistent moves need a real session ID
      if (opts?.persistentOnly !== undefined && !opts.persistentOnly) continue;
      if (!sessionId) continue; // can't activate persistent without a session
      try {
        await activateMove({
          moveName: spec.name,
          sessionId,
          inputs: spec.inputs ?? {},
          cwd,
          userProfile,
        });
        result.activatedPersistent.push(spec.name);
        console.log(`[${prefix}] persistent move "${spec.name}" activated on ${sessionId}`);
      } catch (err) {
        console.error(`[${prefix}] persistent move activation failed for "${spec.name}":`, err);
      }
    } else {
      // Non-persistent: one-shot gather
      if (opts?.persistentOnly) continue;
      if (
        opts?.skipPreviouslyInjectedForSession
        && sessionHasMoveContext(opts.skipPreviouslyInjectedForSession, spec.name)
      ) {
        console.log(
          `[${prefix}] inline move "${spec.name}" already present in logical session `
          + `${opts.skipPreviouslyInjectedForSession}; skipping duplicate gather`,
        );
        continue;
      }
      try {
        console.log(`[${prefix}] gathering inline move "${spec.name}" (cwd=${cwd}, origin=${moveCfg.origin})`);
        const gathered = await gatherMoveOnce(
          spec.name,
          sessionId,
          cwd,
          userProfile,
          spec.inputs ?? {},
          { persistApiRegistration: opts?.persistInlineApiRegistrations },
        );
        if (gathered) {
          console.log(`[${prefix}] move "${spec.name}" gathered ${gathered.text.length} chars`);
          inlineParts.push(`<!-- move:${spec.name} -->\n${gathered.text}\n<!-- /move:${spec.name} -->`);
          if (gathered.apiToken) result.apiTokens.push(gathered.apiToken);
        } else {
          console.warn(`[${prefix}] move "${spec.name}" gather returned null — module missing gather() or gather timed out`);
        }
      } catch (err) {
        console.error(`[${prefix}] move gather failed for "${spec.name}":`, err);
      }
    }
  }

  if (inlineParts.length > 0) {
    result.inlineContext = inlineParts.join("\n\n");
  }

  return result;
}

/** List all available moves for a CWD */
export function listMoves(cwd: string): MoveConfig[] {
  const names = new Set<string>();
  try {
    if (existsSync(BUILTIN_MOVES_DIR)) {
      for (const entry of readdirSync(BUILTIN_MOVES_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
    const projectDir = projectMovesDir(cwd);
    if (existsSync(projectDir)) {
      for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
    for (const plugin of listEnabledModusPlugins()) {
      const pluginDir = getPluginMovesDir(plugin);
      if (!existsSync(pluginDir)) continue;
      for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
  } catch {
    // directory doesn't exist or isn't readable
  }
  return Array.from(names)
    .sort()
    .map((name) => getMove(name, cwd))
    .filter((config): config is MoveConfig => !!config && config.enabled !== false);
}

/** Install move-local dependencies on first activation. Moves can ship their
 * own package.json — deps resolve from the move dir's node_modules, staying
 * scoped to the move instead of the host project. Explicit install (rather
 * than Bun's runtime auto-install) so versions are pinned and failures are
 * visible. Async so a slow network install never blocks the event loop.
 * Skipped when node_modules already exists — delete it to force a refresh
 * after editing the move's package.json. */
async function ensureMoveDeps(dir: string): Promise<void> {
  if (!existsSync(join(dir, "package.json"))) return;
  if (existsSync(join(dir, "node_modules"))) return;
  console.log(`[moves] installing dependencies for ${dir}`);
  const proc = Bun.spawn([process.execPath, "install"], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.warn(`[moves] dependency install failed for ${dir}:`, stderr);
  }
}

/** Load move module (context.ts) if it exists */
async function loadMoveModule(name: string, cwd: string): Promise<MoveModule | null> {
  const location = resolveMoveLocation(name, cwd);
  if (!location) return null;
  const modulePath = join(location.dir, "context.ts");
  if (!existsSync(modulePath)) return null;
  await ensureMoveDeps(location.dir);
  try {
    // Bust module cache so move code changes take effect on re-activation
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    const mod = await import(modulePath);
    // Ensure context.ts reloads on subsequent calls for hot-reloads
    if (mod?.gather || mod?.onSubmit || mod?.onAssistantTurn) {
      const futureResolved = require.resolve(modulePath);
      if (futureResolved !== resolved) {
        delete require.cache[futureResolved];
        delete require.cache[resolved];
      }
    }
    return mod as MoveModule;
  } catch (err) {
    console.error(`[move-runner] Failed to load context.ts for move "${name}":`, err);
    return null;
  }
}

// ── Token Generation ──

function generateToken(): string {
  // Short, opaque, URL-safe
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 16);
}

// ── Trust & Capability Enforcement ──

type ResolveTrust = "builtin" | "reviewed" | "experimental";

/** Resolve trust tier for a move — inferred from origin when not declared */
function resolveTrust(config: MoveConfig | undefined): ResolveTrust {
  if (config?.trust) return config.trust;
  return config?.origin === "harness" ? "builtin" : "experimental";
}

/**
 * Check a capability and enforce based on trust tier.
 *   - builtin:      never blocked (trusted code)
 *   - reviewed:     blocked if capability is explicitly false
 *   - experimental: never blocked, but denial is logged as a warning
 */
function assertCapability(
  caps: MoveCapabilities,
  capability: keyof MoveCapabilities,
  moveName: string,
  detail?: string,
  trust?: ResolveTrust,
): void {
  const tier = trust ?? "experimental";

  // Builtin moves are fully trusted — skip checks
  if (tier === "builtin") return;

  if (caps[capability] === false) {
    const msg = `Move "${moveName}" declared capabilities.${capability}: false${detail ? ` — ${detail}` : ""}`;

    if (tier === "reviewed") {
      // Reviewed moves: hard enforcement
      logActivity({
        eventType: "move_capability_denied",
        summary: msg,
        metadata: { moveName, capability, trust: tier },
      });
      throw new Error(msg);
    }

    // Experimental moves: log warning but don't block
    logActivity({
      eventType: "move_capability_warning",
      summary: `[experimental] ${msg}`,
      metadata: { moveName, capability, trust: tier },
    });
  }
}

// ── Context Builder ──

function buildMoveContext(
  moveName: string,
  sessionId: string,
  cwd: string,
  userProfile: string | undefined,
  opts?: { inputs?: Record<string, unknown>; token?: string; schema?: string; metadata?: Record<string, unknown>; apiToken?: string; instanceId?: string },
): MoveContext {
  const active = getActiveSession(sessionId);
  const metadata = opts?.metadata ?? {};
  const moveCfg = getMove(moveName, cwd);
  const caps = moveCfg?.capabilities ?? {};
  const trust = resolveTrust(moveCfg ?? undefined);

  // Wire state API for API moves (always available, not just in onSubmit)
  const instanceId = opts?.instanceId;
  const persist = moveCfg?.api?.state?.persist ?? false;
  const state = instanceId ? buildStateApi(instanceId, moveName, cwd, persist) : undefined;

  const settingsContext = buildHarnessContext({
    kind: "move",
    name: moveName,
    sessionId: sessionId || null,
    caller: "agent",
    cwd,
    userProfile,
    pluginId: moveCfg?.pluginId,
    trust,
    capabilities: caps,
  });

  return {
    moveName,
    sessionId,
    session: {
      lastAssistantText: active?.lastAssistantText ?? "",
      seq: active?.seq ?? 0,
      profile: active?.profile,
      exchangeCount: active?.exchangeCount ?? 0,
    },
    cwd,
    userProfile,
    inputs: opts?.inputs ?? {},
    db: buildMoveDB(moveName, cwd),
    run: async (cmd: string): Promise<string> => {
      assertCapability(caps, "shell", moveName, `cmd: ${cmd.slice(0, 80)}`, trust);
      const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      // ── Audit: log shell execution ──
      logActivity({
        eventType: "move_shell",
        sessionId: sessionId || undefined,
        summary: `${moveName}: ${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`,
        metadata: { moveName, cmd: cmd.slice(0, 500), trust },
      });
      return out.trim();
    },
    harness: buildHarnessBridge(moveName, sessionId, cwd, userProfile, caps, trust),
    pluginSettings: settingsContext.pluginSettings,
    secrets: {
      resolve: (name: string) => resolveSecret(name),
      isSet: (name: string) => isSecretSet(name),
    },
    meta: (key: string, value: unknown) => { metadata[key] = value; },
    token: opts?.token,
    schema: opts?.schema,
    date: new Date().toISOString().split("T")[0],
    apiToken: opts?.apiToken,
    instanceId,
    state,
  };
}

export function buildMoveDB(moveName: string, cwd: string): MoveDB {
  // Scope session queries to the move's project CWD
  const cwdScope = { cwdPrefixes: [cwd] };

  return {
    listSessions(limit = 20) {
      return dbListSessionsForProjects(cwdScope.cwdPrefixes, limit).map((s) => ({
        id: s.id,
        preview: s.preview,
        profile: s.profile,
        status: s.status,
        lastMessageAt: s.last_message_at,
      }));
    },
    getSession(id: string) {
      const s = dbGetSession(id);
      if (!s) return null;
      return {
        id: s.id,
        preview: s.preview,
        profile: s.profile,
        status: s.status,
        lastMessageAt: s.last_message_at,
        user_profile: s.user_profile,
        provider: s.provider,
        model: s.model,
        cwd: s.cwd,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_message_at: s.last_message_at,
        message_count: s.message_count,
        total_cost_usd: s.total_cost_usd,
        title: s.title,
        tags: s.tags,
        parent_session_id: s.parent_session_id,
      };
    },
    searchSessions(query: string, limit = 10) {
      return dbSearchSessions(query, limit, cwdScope).map((h) => ({
        sessionId: h.session_id,
        snippet: h.snippet,
        profile: h.profile,
      }));
    },
    getMoveHistory(mn: string, limit = 10) {
      return getMoveRuns(mn, limit);
    },
    getSessionMessages(sessionId: string) {
      return getSessionMessages(sessionId);
    },
  };
}

function buildHarnessBridge(moveName: string, sourceSessionId: string, cwd: string, userProfile: string | undefined, caps: MoveCapabilities = {}, trust?: ResolveTrust): HarnessBridge {
  // Thin Adapter over the Harness Context — same historic method names/shapes and
  // the same engine ops + safety model. Every `ctx.harness.X` call site is untouched.
  // The one behavior change is intentional: notify() now reaches a real channel
  // (the former console.log stub is gone) via ctx.channels.send.
  const self: HarnessSelf = {
    kind: "move",
    name: moveName,
    sessionId: sourceSessionId || null,
    caller: "agent",
    cwd,
    userProfile,
    pluginId: getMove(moveName, cwd)?.pluginId,
    trust: trust ?? resolveTrust(getMove(moveName, cwd) ?? undefined),
    capabilities: caps,
  };
  const ctx = buildHarnessContext(self);
  return {
    createSession: (opts) => ctx.sessions.create(opts),
    sendMessage: (targetSessionId, content) => ctx.sessions.send(targetSessionId, content),
    triggerAction: (actionName) => ctx.actions.trigger(actionName),
    notify: async (spec) => { await ctx.channels.send(spec.channel, { text: spec.body }); },
    addSessionTag: (targetSessionId, tag) => ctx.sessions.tag(targetSessionId, tag),
    listMoves: () => ctx.moves.list(),
    activateMove: (opts) => ctx.moves.activate(opts),
    watchSessionTurns: (targetSessionId, onTurn) => ctx.sessions.watchTurns(targetSessionId, onTurn),
    model: ctx.model,
  };
}

function applySessionSettingsOverride(
  opts: StartSessionOpts,
  overrides: Record<string, unknown> | undefined,
): StartSessionOpts {
  if (!overrides) return opts;

  return {
    ...opts,
    ...(typeof overrides.provider === "string" ? { provider: overrides.provider } : {}),
    ...(typeof overrides.model === "string" ? { model: overrides.model } : {}),
    ...(typeof overrides.effort === "string" ? { effort: overrides.effort } : {}),
    ...(typeof overrides.maxTurns === "number" ? { maxTurns: overrides.maxTurns } : {}),
    ...(Array.isArray(overrides.tools) ? { tools: overrides.tools.filter((v): v is string => typeof v === "string") } : {}),
    ...(Array.isArray(overrides.disallowedTools) ? { disallowedTools: overrides.disallowedTools.filter((v): v is string => typeof v === "string") } : {}),
    ...(overrides.toolStates && typeof overrides.toolStates === "object" ? { toolStates: overrides.toolStates as Record<string, string> } : {}),
    ...(overrides.providerControls && typeof overrides.providerControls === "object"
      ? { providerControls: overrides.providerControls as Record<string, unknown> }
      : {}),
    ...(typeof overrides.loadProjectSettings === "boolean"
      ? { loadProjectSettings: overrides.loadProjectSettings }
      : {}),
  };
}

function buildSpawnSessionOpts(
  config: MoveConfig,
  prompt: string,
  cwd: string,
  userProfile: string | undefined,
  sourceSessionId: string,
  inputs?: Record<string, unknown>,
): StartSessionOpts {
  const active = sourceSessionId ? getActiveSession(sourceSessionId) : undefined;
  const inputProfile = typeof inputs?.agentProfile === "string" && inputs.agentProfile !== "Current profile"
    ? inputs.agentProfile
    : undefined;
  const explicitProfile = inputProfile ?? config.agentProfile ?? config.session?.profileOverride ?? undefined;
  const resolvedProfile = explicitProfile
    ? resolveProfileKey(explicitProfile, cwd, { pluginId: config.pluginId }) ?? explicitProfile
    : undefined;

  const base: StartSessionOpts = resolvedProfile
    ? {
        prompt,
        profile: resolvedProfile,
        cwd,
        userProfile,
      }
    : {
        prompt,
        profile: active?.profile,
        userProfile: active?.userProfile ?? userProfile,
        provider: active?._configOverrides.provider ?? active?.provider,
        model: active?.model,
        effort: active?._configOverrides.effort,
        maxTurns: active?._configOverrides.maxTurns,
        tools: active?._configOverrides.tools,
        disallowedTools: active?._configOverrides.disallowedTools,
        toolStates: active?._configOverrides.toolStates,
        providerControls: active?._configOverrides.providerControls,
        loadProjectSettings: active?._configOverrides.loadProjectSettings,
        cwd: active?.cwd ?? cwd,
      };

  return applySessionSettingsOverride(base, config.session?.settingsOverride);
}

// ── Default Prompt (for moves without context.ts) ──

function buildDefaultPrompt(config: MoveConfig, token: string): string {
  const schema = config.schemaHint ?? (config.schema ? JSON.stringify(config.schema, null, 2) : "{}");
  const parts: string[] = [];
  parts.push(`## Move: ${config.label}`);
  parts.push(config.description);
  parts.push("");

  if (config.schemaHint || config.schema) {
    parts.push("### Expected output shape");
    parts.push("```");
    parts.push(schema);
    parts.push("```");
    parts.push("");
  }

  if (config.submit?.required !== false) {
    parts.push("### Submission");
    parts.push("When you have completed this move, call the `modus_submit` tool with:");
    parts.push(`- \`token\`: \`${token}\``);
    parts.push("- `data`: your structured output matching the schema above");
    parts.push("");
  }

  return parts.join("\n");
}

// ── JSON Schema Validation (minimal, good enough for V1) ──

function validateSchema(
  data: Record<string, unknown>,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const props = (schema as any).properties ?? {};
  const required: string[] = (schema as any).required ?? [];

  // Check required fields
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  // Check types (shallow)
  for (const [key, spec] of Object.entries(props) as [string, any][]) {
    const val = data[key];
    if (val === undefined) continue;

    if (spec.type === "string" && typeof val !== "string") {
      errors.push(`Field "${key}" must be a string`);
    } else if (spec.type === "integer" && (typeof val !== "number" || !Number.isInteger(val))) {
      errors.push(`Field "${key}" must be an integer`);
    } else if (spec.type === "number" && typeof val !== "number") {
      errors.push(`Field "${key}" must be a number`);
    } else if (spec.type === "boolean" && typeof val !== "boolean") {
      errors.push(`Field "${key}" must be a boolean`);
    } else if (spec.type === "array" && !Array.isArray(val)) {
      errors.push(`Field "${key}" must be an array`);
    } else if (spec.type === "object" && (typeof val !== "object" || Array.isArray(val))) {
      errors.push(`Field "${key}" must be an object`);
    }

    // Range checks
    if (typeof val === "number") {
      if (spec.minimum !== undefined && val < spec.minimum) {
        errors.push(`Field "${key}" must be >= ${spec.minimum}`);
      }
      if (spec.maximum !== undefined && val > spec.maximum) {
        errors.push(`Field "${key}" must be <= ${spec.maximum}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Attach Move (widget-first activation, phase 1) ──

/**
 * Phase 1 of widget-first activation. Creates API registration + widget
 * metadata WITHOUT running gather() or creating a move run. The widget
 * mounts immediately and the user configures it. Phase 2 (activation)
 * happens when the user sends a message or the widget calls activate().
 */
export async function attachMove(opts: AttachMoveOpts): Promise<AttachMoveResult | { error: string }> {
  const { moveName, inputs, cwd, userProfile } = opts;
  const sessionId = opts.sessionId ?? "";

  const config = getMove(moveName, cwd);
  if (!config) return { error: `Move not found: ${moveName}` };
  if (!config.widget?.mountOnAttach) return { error: "Move does not support mountOnAttach" };
  if (!config.api) return { error: "mountOnAttach requires an api declaration" };

  const instanceId = typeof inputs?.instanceId === "string" && inputs.instanceId
    ? inputs.instanceId
    : generateInstanceId();

  const mod = await loadMoveModule(moveName, cwd);
  if (!mod?.handlers) return { error: `Move "${moveName}" declares api but context.ts has no handlers export` };

  const apiToken = registerMoveApi(
    moveName,
    instanceId,
    sessionId,
    cwd,
    mod.handlers,
    config.api.state?.persist ?? false,
    userProfile,
    mod.inferOp,
  );
  await syncMoveAssistantTurnListener(apiToken, mod);

  logActivity({
    userProfile,
    eventType: "move_activated",
    sessionId: sessionId || undefined,
    summary: `Move attached (widget-first): ${config.label}`,
    metadata: { moveName, apiToken, instanceId, phase: "attach" },
  });

  return {
    apiToken,
    instanceId,
    widget: {
      label: config.widget.label,
      icon: config.widget.icon,
      autoOpen: true,
      mountOnAttach: true,
      cache: config.widget.cache,
      moduleUrl: `/api/moves/${moveName}/widget?cwd=${encodeURIComponent(cwd)}`,
      moveName,
    },
  };
}

/**
 * Phase 2 of widget-first activation (called from widget or detach cleanup).
 * Runs gather(), creates move run, sends the message to the session.
 * The API registration already exists from the attach phase.
 */
export async function activateAttachedMove(opts: {
  apiToken: string;
  text?: string;
  userProfile?: string;
}): Promise<{ ok: boolean; prompt?: string; moveRunId?: number; error?: string }> {
  const reg = moveApiRegistry.get(opts.apiToken);
  if (!reg) return { ok: false, error: "Invalid API token — move not attached" };

  // mountOnAttach: move was registered before a session existed.
  // Session creation + rekey is in flight — wait for it to land.
  if (!reg.sessionId) {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (reg.sessionId) break;
    }
    if (!reg.sessionId) {
      console.log("[move-reg] activateAttachedMove: timed out waiting for session rekey");
      return { ok: false, error: "No session created — activate timed out waiting for session" };
    }
    console.log(`[move-reg] activateAttachedMove: session rekey arrived → ${reg.sessionId}`);
  }

  const config = getMove(reg.moveName, reg.cwd);
  if (!config) return { ok: false, error: `Move not found: ${reg.moveName}` };

  // Build context — API token/instanceId are already registered
  const gatheredContext: Record<string, unknown> = {};

  // Generate submit token + schema if the move uses submit
  const token = config.submit?.required !== false ? generateToken() : undefined;
  const schema = config.schemaHint ?? (config.schema ? JSON.stringify(config.schema, null, 2) : undefined);

  const moveCtx = buildMoveContext(reg.moveName, reg.sessionId, reg.cwd, opts.userProfile, {
    inputs: {},
    token,
    schema,
    metadata: gatheredContext,
  });
  moveCtx.apiToken = opts.apiToken;
  moveCtx.instanceId = reg.instanceId;

  // Run prepare() (heavy setup) then gather()
  let prompt: string;
  try {
    const mod = await loadMoveModule(reg.moveName, reg.cwd);
    if (mod?.prepare) {
      await Promise.race([
        mod.prepare(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("prepare() timed out")), prepareTimeoutFor(config))
        ),
      ]);
    }
    if (mod?.gather) {
      const result = await Promise.race([
        mod.gather(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("gather() timed out")), gatherTimeoutFor(config, ACTIVATE_GATHER_TIMEOUT_MS))
        ),
      ]);
      if (result === null) return { ok: false, error: "gather() returned null — activation skipped" };
      prompt = typeof result === "string" ? result : String(result);
    } else {
      prompt = `## ${config.label}\n${config.description}`;
    }

    // Append modus_submit protocol for API moves
    if (opts.apiToken && config.api?.ops) {
      prompt += buildApiOpsProtocol(opts.apiToken, config);
    }
  } catch (err) {
    return { ok: false, error: `gather() failed: ${err}` };
  }

  // Create move run
  const moveRunId = insertMoveRun({
    moveName: reg.moveName,
    sessionId: reg.sessionId,
    mode: "inline",
    status: "running",
    inputs: "{}",
    gatheredContext: JSON.stringify(gatheredContext),
  });

  // Register submit token if the move uses submit
  if (token) {
    const moveToken: MoveToken = {
      token,
      sessionId: reg.sessionId,
      moveName: reg.moveName,
      mode: "inline",
      schema: config.schema,
      inputs: {},
      gatheredContext,
      cwd: reg.cwd,
      userProfile: opts.userProfile,
      createdAt: Date.now(),
      ttl: DEFAULT_TTL_MS,
      status: "pending",
      attempts: 0,
      maxAttempts: config.submit?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      moveRunId,
      spawnedSessionId: null,
      apiToken: opts.apiToken,
      instanceId: reg.instanceId,
    };
    tokenStore.set(token, moveToken);
  }

  // Combine with user text
  const finalPrompt = opts.text ? `${prompt}\n\n${opts.text}` : prompt;

  // Send message to session
  await interactWithSession({
    sessionId: reg.sessionId,
    prompt: finalPrompt,
    cwd: reg.cwd,
    createIfMissing: false,
  });

  logActivity({
    userProfile: opts.userProfile,
    eventType: "move_activated",
    sessionId: reg.sessionId || undefined,
    summary: `Move activated (from widget): ${config.label}`,
    metadata: { moveName: reg.moveName, apiToken: opts.apiToken, instanceId: reg.instanceId, phase: "activate" },
  });

  return { ok: true, prompt: finalPrompt, moveRunId };
}

/**
 * Clean up an attached move (user closed widget / detached).
 * Removes the API registration and cleans up persisted registry if applicable.
 */
export function detachMove(apiToken: string): boolean {
  const reg = moveApiRegistry.get(apiToken);
  if (!reg) return false;

  // Clean up persisted registry entry
  dropPersistedMoveRegistration(apiToken);

  clearMoveAssistantTurnListener(apiToken);
  instanceStore.delete(reg.instanceId);
  moveApiRegistry.delete(apiToken);
  console.log(`[move-runner] detached: ${reg.moveName}`);
  return true;
}

// ── Activate Move ──

export async function activateMove(opts: ActivateMoveOpts): Promise<ActivateMoveResult | { error: string }> {
  const { moveName, sessionId, inputs, cwd, userProfile, modeOverride, forceNewSession } = opts;
  const sourceSessionId = sessionId ?? "";

  // Load move config
  const config = getMove(moveName, cwd);
  if (!config) return { error: `Move not found: ${moveName}` };
  if (config.enabled === false) return { error: `Move is disabled: ${moveName}` };

  // ── Persistent (ambient) activation ──
  if (config.persistent) {
    if (!sourceSessionId) return { error: "Persistent moves require a session" };

    // Check if already active
    const existing = getActiveAmbientMoves(sourceSessionId);
    if (existing.some(r => r.moveName === moveName)) {
      return { error: `Ambient move "${moveName}" is already active on this session` };
    }

    // Create DB record
    const moveRunId = insertMoveRun({
      moveName,
      sessionId: sourceSessionId,
      mode: "persistent",
      status: "active",
      inputs: JSON.stringify(inputs),
      gatheredContext: "{}",
    });

    // Register API handlers if the move declares ops
    let apiToken: string | undefined;
    let instanceId: string | undefined;
    const mod = await loadMoveModule(moveName, cwd);
    if (config.api?.ops && mod?.handlers) {
      instanceId = generateInstanceId();
      apiToken = registerMoveApi(moveName, instanceId, sourceSessionId, cwd, mod.handlers, false, userProfile, mod.inferOp);
    }

    // Register in ambient registry
    registerAmbientMove({
      moveName,
      sessionId: sourceSessionId,
      cwd,
      userProfile,
      inputs,
      activatedAt: Date.now(),
      moveRunId,
      apiToken,
      instanceId,
    });

    logActivity({
      userProfile,
      eventType: "move_activated",
      sessionId: sourceSessionId,
      summary: `Ambient move activated: ${config.label}`,
      metadata: { moveName, persistent: true },
    });

    return {
      token: apiToken ?? "",
      mode: "persistent" as any,
      persistent: true,
      moveRunId,
    };
  }

  let mode = modeOverride ?? config.mode ?? "inline";
  if (forceNewSession && mode === "inline") {
    mode = "branch";
  }

  // Generate token first — gather() needs it for prompt construction
  const token = generateToken();
  const schema = config.schemaHint ?? (config.schema ? JSON.stringify(config.schema, null, 2) : "{}");

  // Shared metadata bag — gather() populates via ctx.meta()
  const gatheredContext: Record<string, unknown> = {};

  // Build context with inputs, token, and schema available
  const moveCtx = buildMoveContext(moveName, sourceSessionId, cwd, userProfile, {
    inputs,
    token,
    schema,
    metadata: gatheredContext,
  });

  // ── API contract: register handlers and create API token ──
  let apiToken: string | undefined;
  let instanceId: string | undefined;

  if (config.api) {
    instanceId = typeof inputs?.instanceId === "string" && inputs.instanceId
      ? inputs.instanceId        // resume existing instance
      : generateInstanceId();    // new instance

    const mod = await loadMoveModule(moveName, cwd);
    if (mod?.handlers) {
      apiToken = registerMoveApi(
        moveName,
        instanceId,
        sourceSessionId,
        cwd,
        mod.handlers,
        config.api.state?.persist ?? false,
        userProfile,
        mod.inferOp,
      );
      // Make API token and store available in context for gather()
      moveCtx.apiToken = apiToken;
      moveCtx.instanceId = instanceId;
      moveCtx.store = <T = unknown>() => instanceStore.get(instanceId!) as T | undefined;
      moveCtx.setStore = (value: unknown) => { instanceStore.set(instanceId!, value); };
      await syncMoveAssistantTurnListener(apiToken, mod);
    } else {
      return { error: `Move "${moveName}" declares api but context.ts has no handlers export` };
    }
  }

  // Run prepare() (heavy setup) before gather, then gather (fast prompt build)
  let prompt: string;
  try {
    const mod = await loadMoveModule(moveName, cwd);
    if (mod?.prepare) {
      await Promise.race([
        mod.prepare(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("prepare() timed out")), prepareTimeoutFor(config))
        ),
      ]);
    }
    if (mod?.gather) {
      const result = await Promise.race([
        mod.gather(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("gather() timed out")), gatherTimeoutFor(config))
        ),
      ]);
      // Gather-bail: null means skip this activation
      if (result === null) {
        logActivity({
          userProfile,
          eventType: "move_activated",
          sessionId: sourceSessionId || undefined,
          summary: `Move gather bailed: ${config.label}`,
          metadata: { moveName, gatherBail: true },
        });
        return { error: "gather() returned null — activation skipped" };
      }
      prompt = typeof result === "string" ? result : String(result);
    } else {
      prompt = buildDefaultPrompt(config, token);
    }

    // Append modus_submit protocol for API moves
    if (apiToken && config.api?.ops) {
      prompt += buildApiOpsProtocol(apiToken, config);
    }
  } catch (err) {
    console.error(`[move-runner] gather() failed for "${moveName}":`, err);
    return { error: `gather() failed: ${err}` };
  }

  // Create persisted execution record (gatheredContext now has meta() values from gather)
  const moveRunId = insertMoveRun({
    moveName,
    sessionId: sourceSessionId,
    mode,
    status: "pending",
    inputs: JSON.stringify(inputs),
    gatheredContext: JSON.stringify(gatheredContext),
    token,
  });

  // Store token
  const moveToken: MoveToken = {
    token,
    sessionId: sourceSessionId,
    moveName,
    mode,
    schema: config.schema,
    inputs,
    gatheredContext,
    cwd,
    userProfile,
    createdAt: Date.now(),
    ttl: DEFAULT_TTL_MS,
    status: "pending",
    attempts: 0,
    maxAttempts: config.submit?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    moveRunId,
    spawnedSessionId: null,
    apiToken,
    instanceId,
  };
  tokenStore.set(token, moveToken);

  // Log activity
  logActivity({
    userProfile,
    eventType: "move_activated",
    sessionId: sourceSessionId || undefined,
    summary: `Move activated: ${config.label} (${mode})`,
    metadata: { moveName, mode, token, ...(apiToken ? { apiToken, instanceId } : {}) },
  });

  // Build widget metadata if declared
  const widget = config.widget ? {
    label: config.widget.label,
    icon: config.widget.icon,
    autoOpen: config.widget.autoOpen,
    mountOnAttach: config.widget.mountOnAttach,
    cache: config.widget.cache,
    moduleUrl: `/api/moves/${moveName}/widget?cwd=${encodeURIComponent(cwd)}`,
    moveName,
  } : undefined;

  // Execute based on mode
  if (mode === "inline") {
    // Return rendered prompt for client to merge into the current user message
    return { token, mode, moveRunId, prompt, apiToken, instanceId, widget };
  }

  if (mode === "branch" || mode === "background") {
    // Spawn a new session with the move prompt
    const spawned = startSession(
      buildSpawnSessionOpts(config, prompt, cwd, userProfile, sourceSessionId, inputs),
    );

    // Wait for provider init so spawned.sessionId reflects the post-rekey backend ID
    const _spawnWait = Date.now();
    while (spawned.status === "starting" && Date.now() - _spawnWait < 8000) {
      await Bun.sleep(100);
    }

    moveToken.spawnedSessionId = spawned.sessionId;

    // Hide background/branch sessions from the main sidebar when declared.
    // The "internal" tag is filtered out by every session-list query in db.ts.
    if (config.hidden === true) {
      try { dbAddSessionTag(spawned.sessionId, "internal"); } catch { /* best effort */ }
    }

    // Update registry so getActiveWidgetForSession(spawnedSessionId) works
    if (apiToken) {
      const reg = moveApiRegistry.get(apiToken);
      if (reg) {
        reg.sessionId = spawned.sessionId;
        const mod = await loadMoveModule(moveName, cwd);
        await syncMoveAssistantTurnListener(apiToken, mod);
      }
    }

    updateMoveRun(moveRunId, {
      status: "running",
      spawnedSessionId: spawned.sessionId,
    });

    return {
      token,
      mode,
      spawnedSessionId: spawned.sessionId,
      moveRunId,
      apiToken,
      instanceId,
      widget,
    };
  }

  return { error: `Unknown mode: ${mode}` };
}

// ── Handle Submit (called by modus_submit MCP tool) ──

export async function handleSubmit(
  token: string,
  data: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string; error?: string; retry?: boolean }> {
  const moveToken = tokenStore.get(token);

  if (!moveToken) {
    return { ok: false, error: "Invalid or expired token" };
  }

  if (moveToken.status === "completed") {
    return { ok: false, error: "Move already completed" };
  }

  if (moveToken.status === "expired") {
    return { ok: false, error: "Move token expired" };
  }

  // Check TTL
  if (Date.now() - moveToken.createdAt > moveToken.ttl) {
    moveToken.status = "expired";
    tokenStore.delete(token);
    updateMoveRun(moveToken.moveRunId!, { status: "expired" });
    return { ok: false, error: "Move token expired" };
  }

  // Increment attempts
  moveToken.attempts++;

  // ── Audit: log every submit attempt ──
  logActivity({
    eventType: "move_submit",
    sessionId: moveToken.sessionId || undefined,
    summary: `${moveToken.moveName} submit attempt ${moveToken.attempts}/${moveToken.maxAttempts}`,
    metadata: {
      moveName: moveToken.moveName,
      mode: moveToken.mode,
      attempt: moveToken.attempts,
      maxAttempts: moveToken.maxAttempts,
      fields: Object.keys(data),
    },
  });

  // Validate against schema if present
  if (moveToken.schema) {
    const { valid, errors } = validateSchema(data, moveToken.schema);
    if (!valid) {
      const canRetry = moveToken.attempts < moveToken.maxAttempts;
      moveToken.status = "invalid";
      updateMoveRun(moveToken.moveRunId!, {
        status: "invalid",
        error: errors.join("; "),
      });

      if (canRetry) {
        return {
          ok: false,
          error: `Validation failed: ${errors.join("; ")}`,
          retry: true,
        };
      }
      return {
        ok: false,
        error: `Validation failed after ${moveToken.attempts} attempts: ${errors.join("; ")}`,
        retry: false,
      };
    }
  }

  // Load move config to get the CWD
  // We stored the session ID, look up the active session to get cwd
  const active = moveToken.sessionId ? getActiveSession(moveToken.sessionId) : undefined;
  const cwd = moveToken.cwd;

  // Call onSubmit() if context.ts exists
  let submitResult: SubmitResult = {};
  try {
    const mod = await loadMoveModule(moveToken.moveName, cwd);
    if (mod?.onSubmit) {
      const ctx = buildMoveContext(
        moveToken.moveName,
        moveToken.sessionId,
        cwd,
        moveToken.userProfile ?? active?.userProfile,
        { inputs: moveToken.inputs, apiToken: moveToken.apiToken, instanceId: moveToken.instanceId },
      );
      submitResult = await mod.onSubmit(ctx, data, moveToken.inputs);
    }
  } catch (err) {
    console.error(`[move-runner] onSubmit() failed for "${moveToken.moveName}":`, err);
    updateMoveRun(moveToken.moveRunId!, {
      status: "error",
      error: String(err),
    });
    return { ok: false, error: `onSubmit() failed: ${err}` };
  }

  if (submitResult.error) {
    updateMoveRun(moveToken.moveRunId!, {
      status: "error",
      error: submitResult.error,
    });
    return { ok: false, error: submitResult.error };
  }

  // Mark completed
  moveToken.status = "completed";
  updateMoveRun(moveToken.moveRunId!, {
    status: "completed",
    summary: submitResult.message ?? `Submitted ${Object.keys(data).length} fields`,
    spawnedSessionId: submitResult.spawnedSessionId ?? undefined,
    completedAt: Date.now(),
  });

  // Send notification if requested — routes to the real channel egress primitive
  // (gated through the Harness Context, same as ctx.harness.notify).
  if (submitResult.notify) {
    const notifyCfg = getMove(moveToken.moveName, cwd);
    const notifyCtx = buildHarnessContext({
      kind: "move",
      name: moveToken.moveName,
      sessionId: moveToken.sessionId || null,
      caller: "agent",
      cwd,
      userProfile: moveToken.userProfile ?? active?.userProfile,
      pluginId: notifyCfg?.pluginId,
      trust: resolveTrust(notifyCfg ?? undefined),
      capabilities: notifyCfg?.capabilities ?? {},
    });
    const res = await notifyCtx.channels.send(submitResult.notify.channel, { text: submitResult.notify.body });
    if (!res.ok) {
      console.error(`[move-runner] SubmitResult.notify failed for "${submitResult.notify.channel}": ${res.error}`);
    }
  }

  // Log activity
  logActivity({
    userProfile: moveToken.userProfile ?? active?.userProfile,
    eventType: "move_completed",
    sessionId: moveToken.sessionId || undefined,
    summary: `Move completed: ${moveToken.moveName}`,
    metadata: {
      moveName: moveToken.moveName,
      mode: moveToken.mode,
      token,
      fields: Object.keys(data),
    },
  });

  // Apply afterSubmit
  const config = getMove(moveToken.moveName, cwd);
  const after = config?.session?.afterSubmit ?? "continue";
  if (after === "end") {
    // End the spawned session so the agent doesn't keep looping after a successful submit.
    // Without this, models that don't treat a tool-call-success as a turn terminator
    // (e.g. Mistral Small) will re-submit the same token forever, racking up tokens and $.
    const spawnedId = moveToken.spawnedSessionId;
    if (spawnedId) {
      try { stopSession(spawnedId); } catch (err) {
        console.error(`[move-runner] afterSubmit=end: failed to stop spawned session ${spawnedId}:`, err);
      }
    }
  } else if (after.startsWith("switch:")) {
    const targetProfile = after.slice("switch:".length);
    // Profile switch is handled externally via session-manager
    return {
      ok: true,
      message: submitResult.message ?? `Move completed. Switching to ${targetProfile}.`,
    };
  }

  return {
    ok: true,
    message: submitResult.message ?? "Move completed successfully.",
  };
}


// ── Token Queries ──

export function getToken(token: string): MoveToken | undefined {
  return tokenStore.get(token);
}

export function getActiveTokensForSession(sessionId: string): MoveToken[] {
  const tokens: MoveToken[] = [];
  for (const tok of tokenStore.values()) {
    if (tok.sessionId === sessionId && tok.status === "pending") {
      tokens.push(tok);
    }
  }
  return tokens;
}

// ── Registry Rehydration (restart survival) ──

/**
 * Scan every project root referenced by session history for persisted API
 * registrations. Handler state and capability-registration persistence are
 * independent: stateless profile moves still need their existing token
 * reconnected after a harness restart.
 *
 * Runs once at boot, and again for a single token when an unknown one is
 * submitted — a project whose cwd was not yet in session history at boot, or a
 * registration written by a later process, is only reachable that way.
 */
async function rehydrateMoveApiRegistry(opts?: { onlyToken?: string }): Promise<number> {
  const scopes = new Set<string>([
    resolve(process.cwd()),
    APP_PATHS.resourcesDir,
    ...listSessionCwds().map((cwd) => resolve(cwd)),
  ]);
  let rehydrated = 0;

  for (const cwd of scopes) {
    const movesRoot = join(cwd, MODUS_MOVES_DIR);
    if (!existsSync(movesRoot)) continue;

    let names: string[];
    try {
      names = readdirSync(movesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }

    for (const name of names) {
      const registry = readMoveRegistry(cwd, name);
      if (Object.keys(registry).length === 0) continue;
      if (opts?.onlyToken && !registry[opts.onlyToken]) continue;

      const config = getMove(name, cwd);
      if (!config?.api) continue;

      const mod = await loadMoveModule(name, cwd);
      if (!mod?.handlers) {
        console.warn(`[move-runner] rehydrate: ${name} has _registry.json but no handlers in context.ts`);
        continue;
      }

      for (const [token, entry] of Object.entries(registry)) {
        if (opts?.onlyToken && token !== opts.onlyToken) continue;
        const entryCwd = entry.cwd ? resolve(entry.cwd) : cwd;
        const persistState = entry.persistState ?? config.api.state?.persist ?? false;

        moveApiRegistry.set(token, {
          moveName: name,
          instanceId: entry.instanceId,
          sessionId: entry.sessionId,
          cwd: entryCwd,
          userProfile: entry.userProfile,
          handlers: mod.handlers,
          persist: persistState,
          persistRegistration: true,
          defaultOp: typeof config.api.defaultOp === "string" ? config.api.defaultOp : undefined,
          inferOp: mod.inferOp,
        });

        if (persistState) {
          const statePath = join(entryCwd, MODUS_MOVES_DIR, name, "state", `${entry.instanceId}.json`);
          try {
            const raw = readFileSync(statePath, "utf-8");
            moveApiState.set(entry.instanceId, JSON.parse(raw));
          } catch {
            moveApiState.set(entry.instanceId, undefined);
          }
        } else {
          moveApiState.set(entry.instanceId, undefined);
        }

        await syncMoveAssistantTurnListener(token, mod);
        rehydrated++;
      }
    }
  }

  if (rehydrated > 0) {
    console.log(`[move-runner] rehydrated ${rehydrated} API move instance(s) from disk`);
  }
  return rehydrated;
}

/**
 * Last chance for an unknown token: it may be a live registration written by an
 * earlier process that this one never scanned. Returns the registration if the
 * scan recovered it.
 */
async function recoverMoveApiRegistration(token: string): Promise<MoveApiRegistration | undefined> {
  if (!isMoveApiToken(token)) return undefined;
  try {
    await rehydrateMoveApiRegistry({ onlyToken: token });
  } catch (err) {
    console.error(`[move-runner] on-demand rehydration failed for ${token}:`, err);
  }
  return moveApiRegistry.get(token);
}

// Run rehydration on module load (harness boot)
rehydrateMoveApiRegistry().catch((err) => {
  console.error("[move-runner] registry rehydration failed:", err);
});

// ── Public API for move run history ──

export { getMoveRuns } from "./move-db";
