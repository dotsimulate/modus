/**
 * Harness Context — the canonical server-side capability contract for MO.
 *
 * Moves (gather/onSubmit/handlers), actions (gather/verify/afterRun), api-handlers,
 * and missions all ultimately drive the SAME harness engines (session-manager,
 * action-runner, move-runner, db, notify). Historically each surface exposed its
 * own asymmetric slice with different names, powers, and safety checks. This module
 * is the Facade that unifies them: one namespaced capability object, one safety model.
 *
 * The old surfaces (HarnessBridge, MoveApiContext, ActionContext, api-handler) become
 * thin Adapters over this contract — same historic signatures, same underlying behavior.
 *
 * Design constraints (load-bearing):
 *   - NOT a god object. Behavior lives in small capability namespaces
 *     (sessions, channels, moves, actions, state, db, secrets, shell, artifacts,
 *     terminal, log), each independently buildable and gated.
 *   - Capability enforcement happens at the namespace method boundary, so every
 *     old and new surface gets the same safety behavior for the same operation.
 *   - This file MUST NOT top-level-import session-manager / action-runner /
 *     move-runner (they import it). Those three are reached only via lazy require
 *     getters — mirrors the pattern in session-manager.ts:45-67. Hard rule.
 */

// Leaf utilities imported for the live engine bundle (none import the three engines).
import { logActivity } from "./activity";
import { resolveSecret, isSecretSet } from "./secrets";
import { sendToNamedChannel } from "./notify";
import {
  addSessionTag as dbAddSessionTag,
  removeSessionTag as dbRemoveSessionTag,
  insertSessionArtifact,
} from "./db";
import type { TurnContent } from "./db";
import type {
  MoveCapabilities, MoveConfig, MoveDB, MoveSecrets, MoveStateAPI, SessionRef,
} from "./move-types";
import type { SessionTriggerEvent, ActionTerminalHandle } from "./action-types";
import { createPluginSettingsAccessor } from "./plugin-settings";
import {
  buildPromotionPrompt,
  getOneShotRecord,
  listOneShotRecords,
  recordOneShotPromotion,
  runOneShot,
  type OneShotRecord,
  type OneShotUsage,
} from "./model-oneshot";

// ── Engine dependency seam ──
// The whole external surface harness-context drives is bundled here. This keeps the
// "no static import of the three engines" rule in ONE place (liveEngines lazy-requires
// them) and makes every capability module unit-testable by injecting stubs — no global
// module mocking. Types are sourced via `typeof import(...)` (erased; no runtime cycle).

export interface HarnessEngines {
  startSession: typeof import("./session-manager").startSession;
  interactWithSession: typeof import("./session-manager").interactWithSession;
  deliverToSession: typeof import("./session-manager").deliverToSession;
  attachArtifactToSession: typeof import("./session-manager").attachArtifactToSession;
  buildMoveDB: typeof import("./move-runner").buildMoveDB;
  buildStateApi: typeof import("./move-runner").buildStateApi;
  watchMoveSessionTurns: typeof import("./move-runner").watchMoveSessionTurns;
  activateMove: typeof import("./move-runner").activateMove;
  listMoves: typeof import("./move-runner").listMoves;
  triggerAction: typeof import("./action-runner").triggerAction;
  scheduleWake: typeof import("./wake-scheduler").scheduleWake;
  createTerminal: typeof import("./terminal-manager").createTerminal;
  writeTerminal: typeof import("./terminal-manager").writeTerminal;
  killTerminal: typeof import("./terminal-manager").killTerminal;
  sendToNamedChannel: typeof sendToNamedChannel;
  logActivity: typeof logActivity;
  resolveSecret: typeof resolveSecret;
  isSecretSet: typeof isSecretSet;
  insertSessionArtifact: typeof insertSessionArtifact;
  addSessionTag: typeof dbAddSessionTag;
  removeSessionTag: typeof dbRemoveSessionTag;
  runOneShot: typeof runOneShot;
  getOneShotRecord: typeof getOneShotRecord;
  listOneShotRecords: typeof listOneShotRecords;
  recordOneShotPromotion: typeof recordOneShotPromotion;
}

let _live: HarnessEngines | null = null;

/** The real engine bundle. Lazy-requires the three engines (+ wake/terminal) on first
 *  use — never at module init — to avoid the import cycle (they import this module). */
function liveEngines(): HarnessEngines {
  if (_live) return _live;
  const SM = require("./session-manager") as typeof import("./session-manager");
  const MR = require("./move-runner") as typeof import("./move-runner");
  const AR = require("./action-runner") as typeof import("./action-runner");
  const WS = require("./wake-scheduler") as typeof import("./wake-scheduler");
  const TM = require("./terminal-manager") as typeof import("./terminal-manager");
  _live = {
    startSession: SM.startSession,
    interactWithSession: SM.interactWithSession,
    deliverToSession: SM.deliverToSession,
    attachArtifactToSession: SM.attachArtifactToSession,
    buildMoveDB: MR.buildMoveDB,
    buildStateApi: MR.buildStateApi,
    watchMoveSessionTurns: MR.watchMoveSessionTurns,
    activateMove: MR.activateMove,
    listMoves: MR.listMoves,
    triggerAction: AR.triggerAction,
    scheduleWake: WS.scheduleWake,
    createTerminal: TM.createTerminal,
    writeTerminal: TM.writeTerminal,
    killTerminal: TM.killTerminal,
    sendToNamedChannel,
    logActivity,
    resolveSecret,
    isSecretSet,
    insertSessionArtifact,
    addSessionTag: dbAddSessionTag,
    removeSessionTag: dbRemoveSessionTag,
    runOneShot,
    getOneShotRecord,
    listOneShotRecords,
    recordOneShotPromotion,
  };
  return _live;
}

// ── Identity + capabilities ──

/** Capability shape — superset reused from moves (shell/session/action/notify/file). */
export type HarnessCapabilities = MoveCapabilities;

export type HarnessTrust = "builtin" | "reviewed" | "experimental";

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

// ── Capability namespaces ──

export type ChannelResult = { ok: boolean; error?: string };

export type WakeWhen =
  | "now"
  | { at: string }            // ISO timestamp — one-shot
  | { every: string }         // "30m", "1h" — recurring
  | { onEvent: SessionTriggerEvent };

export interface WakeHandle {
  id: string;
  scheduled: boolean;
  /** Session ids delivered to (immediate "now" wakes only). */
  delivered?: string[];
  /** Cancel a scheduled wake. No-op for immediate wakes. */
  cancel(): void;
}

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

export interface HarnessChannels {
  /** Send arbitrary content to a named channel (Discord/Slack/file). The egress primitive. */
  send(channel: string, payload: { text: string; data?: Record<string, unknown> }): Promise<ChannelResult>;
}

export interface HarnessMoves {
  activate(opts: {
    moveName: string;
    inputs?: Record<string, unknown>;
    sessionId?: string;
    modeOverride?: "inline" | "branch" | "background";
  }): Promise<{ token: string; mode: string; spawnedSessionId?: string; moveRunId: number }>;
  list(): MoveConfig[];
}

export interface HarnessActions {
  trigger(name: string): Promise<void>;
}

export type HarnessModelResult = {
  text: string;
  /** Handle for `model.promote()`. */
  oneShotId: string;
  provider: string;
  model: string;
  usage?: OneShotUsage;
};

/**
 * One-shot model calls — a model with no session attached.
 *
 * The cheap rung below `sessions.create()`. Use it for a transform whose answer
 * is a value rather than a conversation: punctuating dictation, naming a thing,
 * classifying, translating. Only the PI provider family can serve these
 * (`supportsOneShotCompletion`); anything else throws rather than quietly
 * spawning a session, because that would reintroduce the cost this exists to
 * avoid.
 */
export interface HarnessModel {
  complete(opts: {
    prompt: string;
    system?: string;
    /** Resolve provider + model from an agent profile. Required for promote(). */
    profile?: string;
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<HarnessModelResult>;
  /**
   * Turn a completed one-shot into a real session that opens with the original
   * exchange replayed as its first message. Idempotent — promoting twice returns
   * the same session id. Requires the one-shot to have named a profile, since a
   * session cannot be spawned without one.
   */
  promote(oneShotId: string, opts?: { userProfile?: string; tags?: string[] }): Promise<{ sessionId: string }>;
  /** Recent one-shots, newest first. Bounded; see ONE_SHOT_STORE_LIMIT. */
  recent(limit?: number): OneShotRecord[];
}

export interface HarnessArtifacts {
  insert(opts: { sessionId: string; name: string; mime: string; path: string; seq?: number; previewText?: string; metadata?: Record<string, unknown> }): number;
  attach(opts: { sessionId: string; seq: number; targetMessageUuid?: string; path: string; name: string; mime: string; previewText?: string; metadata?: Record<string, unknown> }): { id: number; sessionId: string; seq: number; name: string; mime: string; url: string; createdAt: number };
}

export interface HarnessTerminalApi {
  create(opts?: { cwd?: string; shell?: string; cols?: number; rows?: number; env?: Record<string, string> }): ActionTerminalHandle;
}

/** The unified context passed to all server-side extension code. */
export interface HarnessContext {
  self: HarnessSelf;
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

// ── Gating (same model as move-runner.assertCapability) ──

type Gate = (capability: keyof HarnessCapabilities, detail?: string) => void;

function makeGate(self: HarnessSelf, eng: HarnessEngines): Gate {
  const caps = self.capabilities ?? {};
  return (capability, detail) => {
    // Builtin code is fully trusted.
    if (self.trust === "builtin") return;
    if (caps[capability] === false) {
      const msg = `${self.kind} "${self.name}" declared capabilities.${capability}: false${detail ? ` — ${detail}` : ""}`;
      if (self.trust === "reviewed") {
        eng.logActivity({
          eventType: "harness_capability_denied",
          sessionId: self.sessionId ?? undefined,
          summary: msg,
          metadata: { kind: self.kind, name: self.name, capability, trust: self.trust },
        });
        throw new Error(msg);
      }
      // experimental: log, don't block (audit-only)
      eng.logActivity({
        eventType: "harness_capability_warning",
        sessionId: self.sessionId ?? undefined,
        summary: `[experimental] ${msg}`,
        metadata: { kind: self.kind, name: self.name, capability, trust: self.trust },
      });
    }
  };
}

// ── Capability module factories (each takes the injected engine bundle) ──

function createSessions(self: HarnessSelf, gate: Gate, eng: HarnessEngines, db: MoveDB): HarnessSessions {
  return {
    async create(opts) {
      gate("sessionSpawn", `profile: ${opts.profile}`);
      const session = eng.startSession({
        prompt: opts.prompt,
        profile: opts.profile,
        cwd: opts.cwd ?? self.cwd,
        userProfile: opts.userProfile ?? self.userProfile,
        tags: opts.tags,
      });
      const t0 = Date.now();
      while (session.status === "starting" && Date.now() - t0 < 8000) {
        await Bun.sleep(100);
      }
      eng.logActivity({
        eventType: "harness_session_spawn",
        sessionId: self.sessionId ?? undefined,
        agentProfile: opts.profile,
        summary: `${self.kind}:${self.name} spawned session ${session.sessionId} (profile: ${opts.profile})`,
        metadata: { kind: self.kind, name: self.name, spawnedSessionId: session.sessionId, profile: opts.profile },
      });
      return session.sessionId;
    },
    async send(sessionId, content) {
      gate("sessionMessage", `target: ${sessionId}`);
      await eng.interactWithSession({ sessionId, prompt: content, createIfMissing: false });
      eng.logActivity({
        eventType: "harness_send_message",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} → session ${sessionId}: ${content.slice(0, 80)}`,
        metadata: { kind: self.kind, name: self.name, targetSessionId: sessionId, contentLength: content.length },
      });
    },
    async wake(target, content, when) {
      gate("sessionMessage", `wake: ${target}`);
      if (!when || when === "now") {
        const res = await eng.deliverToSession(target, content);
        eng.logActivity({
          eventType: "harness_wake",
          sessionId: self.sessionId ?? undefined,
          summary: `${self.kind}:${self.name} woke "${target}" now → ${res.delivered.length} session(s)`,
          metadata: { kind: self.kind, name: self.name, target, when: "now", delivered: res.delivered, missed: res.missed },
        });
        return { id: "wake-now", scheduled: false, delivered: res.delivered, cancel() {} };
      }
      return eng.scheduleWake({ self, target, content, when });
    },
    watchTurns(sessionId, onTurn) {
      return eng.watchMoveSessionTurns(sessionId, onTurn);
    },
    async tag(sessionId, tag) {
      eng.addSessionTag(sessionId, tag);
      eng.logActivity({
        eventType: "harness_add_tag",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} tagged session ${sessionId} with "${tag}"`,
        metadata: { kind: self.kind, name: self.name, targetSessionId: sessionId, tag },
      });
    },
    async untag(sessionId, tag) {
      eng.removeSessionTag(sessionId, tag);
      eng.logActivity({
        eventType: "harness_remove_tag",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} removed tag "${tag}" from session ${sessionId}`,
        metadata: { kind: self.kind, name: self.name, targetSessionId: sessionId, tag },
      });
    },
    get(id) {
      return db.getSession(id);
    },
    list(limit) {
      return db.listSessions(limit);
    },
  };
}

function createChannels(self: HarnessSelf, gate: Gate, eng: HarnessEngines): HarnessChannels {
  return {
    async send(channel, payload) {
      gate("notify", `channel: ${channel}`);
      const res = await eng.sendToNamedChannel(channel, payload, self.cwd);
      eng.logActivity({
        eventType: "harness_channel_send",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} → channel "${channel}": ${payload.text.slice(0, 80)}`,
        metadata: { kind: self.kind, name: self.name, channel, ok: res.ok, ...(res.error ? { error: res.error } : {}) },
      });
      return res;
    },
  };
}

function createMoves(self: HarnessSelf, eng: HarnessEngines): HarnessMoves {
  return {
    async activate(opts) {
      const result = await eng.activateMove({
        moveName: opts.moveName,
        sessionId: opts.sessionId ?? self.sessionId ?? undefined,
        inputs: opts.inputs ?? {},
        cwd: self.cwd,
        userProfile: self.userProfile,
        modeOverride: opts.modeOverride,
      });
      if ("error" in result) throw new Error(result.error);
      eng.logActivity({
        eventType: "harness_activate_move",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} activated move "${opts.moveName}" (${result.mode})`,
        metadata: { kind: self.kind, name: self.name, targetMove: opts.moveName, mode: result.mode },
      });
      return { token: result.token, mode: result.mode, spawnedSessionId: result.spawnedSessionId, moveRunId: result.moveRunId };
    },
    list() {
      return eng.listMoves(self.cwd);
    },
  };
}

function createActions(self: HarnessSelf, gate: Gate, eng: HarnessEngines): HarnessActions {
  return {
    async trigger(name) {
      gate("actionTrigger", `action: ${name}`);
      await eng.triggerAction(name, { userProfile: self.userProfile, cwd: self.cwd });
      eng.logActivity({
        eventType: "harness_trigger_action",
        sessionId: self.sessionId ?? undefined,
        actionName: name,
        summary: `${self.kind}:${self.name} triggered action "${name}"`,
        metadata: { kind: self.kind, name: self.name },
      });
    },
  };
}

function createModel(
  self: HarnessSelf,
  gate: Gate,
  eng: HarnessEngines,
  sessions: HarnessSessions,
): HarnessModel {
  return {
    async complete(opts) {
      gate("modelCall", `profile: ${opts.profile ?? opts.provider ?? "unresolved"}`);
      const result = await eng.runOneShot({
        prompt: opts.prompt,
        system: opts.system,
        profile: opts.profile,
        provider: opts.provider,
        model: opts.model,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        origin: {
          kind: self.kind,
          name: self.name,
          cwd: self.cwd,
          userProfile: self.userProfile,
          sessionId: self.sessionId,
        },
      });
      eng.logActivity({
        eventType: "harness_model_oneshot",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name} one-shot ${result.provider}/${result.model} → ${result.text.slice(0, 80)}`,
        metadata: {
          kind: self.kind,
          name: self.name,
          provider: result.provider,
          model: result.model,
          oneShotId: result.oneShotId,
          promptLength: opts.prompt.length,
          ...(result.usage ? { totalTokens: result.usage.totalTokens, costUsd: result.usage.costUsd } : {}),
        },
      });
      return result;
    },
    async promote(oneShotId, opts) {
      const record = eng.getOneShotRecord(oneShotId);
      if (!record) {
        throw new Error(
          `one-shot "${oneShotId}" is not in the recent history — it may have aged out of the ring or the backend restarted`,
        );
      }
      // A double-clicked promote button must not cost two sessions.
      if (record.promotedSessionId) return { sessionId: record.promotedSessionId };
      if (!record.profile) {
        throw new Error(
          `one-shot "${oneShotId}" named no agent profile, so there is no profile to start a session with — `
          + `re-run it with a profile if you want it promotable`,
        );
      }
      // Spawn through the sessions namespace so promotion inherits its gate,
      // its starting-status wait, and its activity log entry.
      const sessionId = await sessions.create({
        profile: record.profile,
        prompt: buildPromotionPrompt(record),
        cwd: record.origin.cwd,
        userProfile: opts?.userProfile ?? record.origin.userProfile,
        tags: opts?.tags,
      });
      eng.recordOneShotPromotion(oneShotId, sessionId);
      eng.logActivity({
        eventType: "harness_model_promote",
        sessionId: self.sessionId ?? undefined,
        agentProfile: record.profile,
        summary: `${self.kind}:${self.name} promoted one-shot ${oneShotId} → session ${sessionId}`,
        metadata: { kind: self.kind, name: self.name, oneShotId, spawnedSessionId: sessionId, profile: record.profile },
      });
      return { sessionId };
    },
    recent(limit) {
      return eng.listOneShotRecords(limit);
    },
  };
}

function createArtifacts(self: HarnessSelf, eng: HarnessEngines): HarnessArtifacts {
  return {
    insert(opts) {
      return eng.insertSessionArtifact({
        sessionId: opts.sessionId,
        seq: opts.seq ?? 0,
        name: opts.name,
        mime: opts.mime,
        path: opts.path,
        previewText: opts.previewText,
        metadata: opts.metadata,
      });
    },
    attach(opts) {
      return eng.attachArtifactToSession({
        sessionId: opts.sessionId,
        seq: opts.seq,
        targetMessageUuid: opts.targetMessageUuid,
        path: opts.path,
        name: opts.name,
        mime: opts.mime,
        previewText: opts.previewText,
        metadata: opts.metadata,
        actionName: self.name,
      });
    },
  };
}

function createTerminal(self: HarnessSelf, eng: HarnessEngines): HarnessTerminalApi {
  return {
    create(opts = {}) {
      const term = eng.createTerminal({
        cwd: opts.cwd ?? self.cwd,
        shell: opts.shell,
        cols: opts.cols,
        rows: opts.rows,
        env: opts.env,
        ownerType: self.kind,
        ownerName: self.name,
        kind: self.kind,
        interactive: true,
      });
      const handle: ActionTerminalHandle = {
        id: term.id,
        write(data: string) { eng.writeTerminal(term.id, data); },
        kill() { eng.killTerminal(term.id); },
        waitForExit() { return term.proc.exited; },
      };
      return handle;
    },
  };
}

function createShell(self: HarnessSelf, gate: Gate, eng: HarnessEngines): { run(cmd: string): Promise<string> } {
  return {
    async run(cmd) {
      gate("shell", `cmd: ${cmd.slice(0, 80)}`);
      const proc = Bun.spawn(["sh", "-c", cmd], { cwd: self.cwd, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      eng.logActivity({
        eventType: "harness_shell",
        sessionId: self.sessionId ?? undefined,
        summary: `${self.kind}:${self.name}: ${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`,
        metadata: { kind: self.kind, name: self.name, cmd: cmd.slice(0, 500), trust: self.trust },
      });
      return out.trim();
    },
  };
}

const NOOP_STATE: MoveStateAPI = {
  async get() { return undefined; },
  async set() { /* no instance bound — no-op */ },
  async delete() { /* no instance bound — no-op */ },
};

function createState(self: HarnessSelf, eng: HarnessEngines): MoveStateAPI {
  if (!self.instanceId) return NOOP_STATE;
  return eng.buildStateApi(self.instanceId, self.name, self.cwd, self.statePersist ?? false);
}

// ── Composer ──

/**
 * Build a Harness Context for a caller, backed by the live engine bundle.
 * Capability modules are composed here but OWNED by their factories above — this
 * function does not directly implement any engine operation (god-object mitigation).
 */
export function buildHarnessContext(self: HarnessSelf): HarnessContext {
  return buildHarnessContextWith(self, liveEngines());
}

/**
 * Compose a Harness Context over an explicit engine bundle. Production calls
 * buildHarnessContext (live engines); tests inject stubs here to exercise each
 * capability module in isolation — no global module mocking required.
 */
export function buildHarnessContextWith(self: HarnessSelf, eng: HarnessEngines): HarnessContext {
  const gate = makeGate(self, eng);
  const db = eng.buildMoveDB(self.name, self.cwd);
  const secrets: MoveSecrets = {
    resolve: (name: string) => eng.resolveSecret(name),
    isSet: (name: string) => eng.isSecretSet(name),
  };

  const sessions = createSessions(self, gate, eng, db);

  return {
    self,
    sessions,
    channels: createChannels(self, gate, eng),
    moves: createMoves(self, eng),
    actions: createActions(self, gate, eng),
    model: createModel(self, gate, eng, sessions),
    state: createState(self, eng),
    db,
    secrets,
    shell: createShell(self, gate, eng),
    artifacts: createArtifacts(self, eng),
    terminal: createTerminal(self, eng),
    pluginSettings: createPluginSettingsAccessor(self.pluginId, {
      cwd: self.cwd,
      userProfile: self.userProfile,
    }),
    log(message, metadata) {
      eng.logActivity({
        eventType: "harness_log",
        sessionId: self.sessionId ?? undefined,
        summary: `[${self.kind}:${self.name}] ${message}`,
        metadata: { ...metadata, kind: self.kind, name: self.name },
      });
    },
  };
}
