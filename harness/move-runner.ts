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
 * Token management is in-memory with TTL expiry.
 * Execution records are persisted to DB for recall.
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";
import type {
  MoveConfig, MoveModule, MoveContext, MoveToken,
  ActivateMoveOpts, ActivateMoveResult, SubmitResult,
  AttachMoveOpts, AttachMoveResult,
  MoveDB, HarnessBridge, MoveRun,
  MoveApiHandler, MoveApiContext, MoveApiRegistration, MoveStateAPI,
  AmbientMoveRegistration,
} from "./move-types";
import {
  type StartSessionOpts,
  getActiveSession, queueMessage, startSession,
} from "./session-manager";
import {
  listSessions as dbListSessions, getSession as dbGetSession,
  searchSessions as dbSearchSessions,
} from "./db";
import {
  insertMoveRun, updateMoveRun, getMoveRuns,
} from "./move-db";
import { logActivity } from "./activity";
import { triggerAction } from "./action-runner";

// ── Constants ──

const BUILTIN_MOVES_DIR = join(import.meta.dir, "moves");
const MODUS_MOVES_DIR = ".modus/moves";
const DEFAULT_TTL_MS = 10 * 60_000;       // 10 minutes
const DEFAULT_MAX_ATTEMPTS = 3;
const TOKEN_CLEANUP_INTERVAL_MS = 60_000;  // sweep every 60s
const GATHER_TIMEOUT_MS = 10_000;          // 10s timeout for gather()

// ── Token Store (in-memory) ──

const tokenStore = new Map<string, MoveToken>();

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

  for (const reg of moves) {
    try {
      const mod = await loadMoveModule(reg.moveName, reg.cwd);
      if (!mod?.gather) continue;

      const ctx = buildMoveContext(reg.moveName, sessionId, reg.cwd, reg.userProfile, {
        inputs: reg.inputs,
      });

      const result = await Promise.race([
        mod.gather(ctx),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), GATHER_TIMEOUT_MS)
        ),
      ]);

      // Gather-bail: null means skip this turn
      if (result === null) continue;

      const text = typeof result === "string" ? result : String(result);
      if (text.trim()) {
        parts.push(`<!-- ambient:${reg.moveName} -->\n${text}\n<!-- /ambient:${reg.moveName} -->`);
      }
    } catch (err) {
      console.error(`[move-runner] ambient gather failed for "${reg.moveName}":`, err);
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ── Move API Registry (api tokens → handlers) ──

const MAPI_PREFIX = "mapi-";

/** token → registration */
const moveApiRegistry = new Map<string, MoveApiRegistration>();

/** instanceId → state (in-memory) */
const moveApiState = new Map<string, unknown>();

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

// ── Registry Persistence ──

/** Read the _registry.json for a move's state directory */
function readMoveRegistry(cwd: string, moveName: string): Record<string, { instanceId: string; sessionId: string; cwd: string; createdAt: number }> {
  const path = join(cwd, ".modus/moves", moveName, "state", "_registry.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the _registry.json for a move's state directory */
function writeMoveRegistry(cwd: string, moveName: string, registry: Record<string, unknown>): void {
  const dir = join(cwd, ".modus/moves", moveName, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_registry.json"), JSON.stringify(registry, null, 2));
}

/** Create a move-api token and register handlers */
function registerMoveApi(
  moveName: string,
  instanceId: string,
  sessionId: string,
  cwd: string,
  handlers: Record<string, MoveApiHandler>,
  persist: boolean,
): string {
  const config = getMove(moveName, cwd);
  const prefix = config?.api?.tokenPrefix ?? moveName;
  const token = `${MAPI_PREFIX}${prefix}-${instanceId}`;

  moveApiRegistry.set(token, {
    moveName,
    instanceId,
    sessionId,
    cwd,
    handlers,
    persist,
  });
  console.log(`[move-reg] registerMoveApi: token=${token} sessionId=${sessionId} move=${moveName}`);

  // Initialize state if not already present (resume case)
  if (!moveApiState.has(instanceId)) {
    moveApiState.set(instanceId, undefined);
  }

  // Persist registration for restart survival
  if (persist) {
    const registry = readMoveRegistry(cwd, moveName);
    registry[token] = { instanceId, sessionId, cwd, createdAt: Date.now() };
    writeMoveRegistry(cwd, moveName, registry);
  }

  return token;
}

/** Build the state API for an instance */
function buildStateApi(instanceId: string, moveName: string, cwd: string, persist: boolean): MoveStateAPI {
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

/** Handle a move-api op call (called from modus-mcp.ts) */
export async function handleMoveApiSubmit(
  token: string,
  data: Record<string, unknown>,
  caller: "agent" | "user" = "agent",
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const reg = moveApiRegistry.get(token);
  if (!reg) {
    return { ok: false, error: "Invalid or expired API token" };
  }

  const op = data.op;
  if (typeof op !== "string") {
    return { ok: false, error: "Missing 'op' field" };
  }

  const handler = reg.handlers[op];
  if (!handler) {
    return { ok: false, error: `Unknown op: ${op}` };
  }

  const stateApi = buildStateApi(reg.instanceId, reg.moveName, reg.cwd, reg.persist);

  const ctx: MoveApiContext = {
    instanceId: reg.instanceId,
    sessionId: reg.sessionId,
    moveName: reg.moveName,
    caller,
    state: stateApi,
    notify: (message: string, emit?: { type: string; [key: string]: unknown }) => {
      const injected = emit
        ? `[modus:${emit.type}] ${JSON.stringify(emit)}\n${message}`.trim()
        : message;
      const queued = queueMessage(reg.sessionId, injected);
      if (!queued) {
        // Session not active (e.g. after restart) — resume it with the message
        startSession({
          sessionId: reg.sessionId,
          prompt: injected,
          cwd: reg.cwd,
        });
      }
    },
  };

  return handler(ctx, data);
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
      matched++;
      console.log(`[move-reg] rekey: token=${token} ${oldSessionId} → ${newSessionId}`);
    }
  }
  if (matched === 0) {
    console.log(`[move-reg] rekey: NO MATCH for oldSessionId=${oldSessionId} (registry has ${moveApiRegistry.size} entries: ${[...moveApiRegistry.values()].map(r => r.sessionId).join(", ")})`);
  }
}

/** Get all active move widgets for a session */
export function getActiveWidgetForSession(sessionId: string): Array<{
  widget: { label: string; icon?: string; autoOpen?: boolean; moduleUrl: string; moveName: string };
  apiToken: string;
  instanceId: string;
}> {
  console.log(`[move-reg] getActiveWidgetForSession(${sessionId}) — registry has ${moveApiRegistry.size} entries: ${[...moveApiRegistry.entries()].map(([t, r]) => `${t}→${r.sessionId}`).join(", ") || "empty"}`);
  const results: Array<{ widget: { label: string; icon?: string; autoOpen?: boolean; moduleUrl: string; moveName: string }; apiToken: string; instanceId: string }> = [];
  for (const [token, reg] of moveApiRegistry) {
    if (reg.sessionId === sessionId) {
      const config = getMove(reg.moveName, reg.cwd);
      if (config?.widget?.component) {
        results.push({
          widget: {
            label: config.widget.label ?? reg.moveName,
            icon: config.widget.icon,
            autoOpen: config.widget.autoOpen,
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
  origin: "harness" | "project";
} | null {
  const projectDir = join(projectMovesDir(cwd), name);
  if (existsSync(join(projectDir, "move.json"))) {
    return { dir: projectDir, origin: "project" };
  }

  const builtinDir = join(BUILTIN_MOVES_DIR, name);
  if (existsSync(join(builtinDir, "move.json"))) {
    return { dir: builtinDir, origin: "harness" };
  }

  return null;
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
    return config;
  } catch (err) {
    console.error(`[move-runner] Failed to load move "${name}":`, err);
    return null;
  }
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
  } catch {
    // directory doesn't exist or isn't readable
  }
  return Array.from(names)
    .sort()
    .map((name) => getMove(name, cwd))
    .filter((config): config is MoveConfig => !!config && config.enabled !== false);
}

/** Load move module (context.ts) if it exists */
async function loadMoveModule(name: string, cwd: string): Promise<MoveModule | null> {
  const location = resolveMoveLocation(name, cwd);
  if (!location) return null;
  const modulePath = join(location.dir, "context.ts");
  if (!existsSync(modulePath)) return null;
  try {
    // Bust module cache so move code changes take effect on re-activation
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    const mod = await import(modulePath);
    // Ensure context.ts reloads on subsequent calls for hot-reloads
    if (mod?.gather || mod?.onSubmit) {
      const futureResolved = require.resolve(modulePath);
      if (futureResolved !== resolved) {
        delete require.cache[futureResolved];
        require.cache[resolved] = null;
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

// ── Context Builder ──

function buildMoveContext(
  moveName: string,
  sessionId: string,
  cwd: string,
  userProfile: string | undefined,
  opts?: { inputs?: Record<string, unknown>; token?: string; schema?: string; metadata?: Record<string, unknown> },
): MoveContext {
  const active = getActiveSession(sessionId);
  const metadata = opts?.metadata ?? {};

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
      const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      return out.trim();
    },
    harness: buildHarnessBridge(cwd, userProfile),
    meta: (key: string, value: unknown) => { metadata[key] = value; },
    token: opts?.token,
    schema: opts?.schema,
    date: new Date().toISOString().split("T")[0],
  };
}

function buildMoveDB(moveName: string, cwd: string): MoveDB {
  return {
    listSessions(limit = 20) {
      return dbListSessions(limit).map((s) => ({
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
      };
    },
    searchSessions(query: string, limit = 10) {
      return dbSearchSessions(query, limit).map((h) => ({
        sessionId: h.session_id,
        snippet: h.snippet,
        profile: h.profile,
      }));
    },
    getMoveHistory(mn: string, limit = 10) {
      return getMoveRuns(mn, limit);
    },
  };
}

function buildHarnessBridge(cwd: string, userProfile: string | undefined): HarnessBridge {
  return {
    async createSession(opts) {
      const session = startSession({
        prompt: opts.prompt,
        profile: opts.profile,
        cwd: opts.cwd ?? cwd,
        userProfile: opts.userProfile ?? userProfile,
      });
      // Wait for real session ID
      const start = Date.now();
      while (session.sessionId.startsWith("ses-") && Date.now() - start < 8000) {
        await Bun.sleep(100);
      }
      return session.sessionId;
    },
    async sendMessage(sessionId, content) {
      queueMessage(sessionId, content);
    },
    async triggerAction(actionName) {
      await triggerAction(actionName);
    },
    async notify(spec) {
      console.log(`[move-runner] notify requested on channel "${spec.channel}": ${spec.body}`);
    },
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

  const base: StartSessionOpts = explicitProfile
    ? {
        prompt,
        profile: explicitProfile,
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
  );

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

  const config = getMove(reg.moveName, reg.cwd);
  if (!config) return { ok: false, error: `Move not found: ${reg.moveName}` };

  // Build context — API token/instanceId are already registered
  const gatheredContext: Record<string, unknown> = {};
  const moveCtx = buildMoveContext(reg.moveName, reg.sessionId, reg.cwd, opts.userProfile, {
    inputs: {},
    metadata: gatheredContext,
  });
  moveCtx.apiToken = opts.apiToken;
  moveCtx.instanceId = reg.instanceId;

  // Run gather()
  let prompt: string;
  try {
    const mod = await loadMoveModule(reg.moveName, reg.cwd);
    if (mod?.gather) {
      const result = await Promise.race([
        mod.gather(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("gather() timed out")), GATHER_TIMEOUT_MS)
        ),
      ]);
      if (result === null) return { ok: false, error: "gather() returned null — activation skipped" };
      prompt = typeof result === "string" ? result : String(result);
    } else {
      prompt = `## ${config.label}\n${config.description}`;
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

  // Combine with user text
  const finalPrompt = opts.text ? `${prompt}\n\n${opts.text}` : prompt;

  // Send message to session
  const queued = queueMessage(reg.sessionId, finalPrompt);
  if (!queued) {
    startSession({
      sessionId: reg.sessionId,
      prompt: finalPrompt,
      cwd: reg.cwd,
    });
  }

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
  if (reg.persist) {
    const registry = readMoveRegistry(reg.cwd, reg.moveName);
    if (registry[apiToken]) {
      delete registry[apiToken];
      writeMoveRegistry(reg.cwd, reg.moveName, registry);
    }
  }

  moveApiRegistry.delete(apiToken);
  console.log(`[move-runner] detached: ${reg.moveName} token=${apiToken}`);
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

  // ── Persistent (ambient) activation — separate path, no token/submit ──
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

    // Register in ambient registry
    registerAmbientMove({
      moveName,
      sessionId: sourceSessionId,
      cwd,
      userProfile,
      inputs,
      activatedAt: Date.now(),
      moveRunId,
    });

    logActivity({
      userProfile,
      eventType: "move_activated",
      sessionId: sourceSessionId,
      summary: `Ambient move activated: ${config.label}`,
      metadata: { moveName, persistent: true },
    });

    return {
      token: "",  // no token for persistent moves
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
      );
      // Make API token available in context for gather()
      moveCtx.apiToken = apiToken;
      moveCtx.instanceId = instanceId;
    } else {
      return { error: `Move "${moveName}" declares api but context.ts has no handlers export` };
    }
  }

  // Call gather() if context.ts exists, otherwise build a default prompt
  let prompt: string;
  try {
    const mod = await loadMoveModule(moveName, cwd);
    if (mod?.gather) {
      const result = await Promise.race([
        mod.gather(moveCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("gather() timed out")), GATHER_TIMEOUT_MS)
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

    // Wait for real session ID
    const start = Date.now();
    while (spawned.sessionId.startsWith("ses-") && Date.now() - start < 8000) {
      await Bun.sleep(100);
    }

    moveToken.spawnedSessionId = spawned.sessionId;

    // Update registry so getActiveWidgetForSession(spawnedSessionId) works
    if (apiToken) {
      const reg = moveApiRegistry.get(apiToken);
      if (reg) reg.sessionId = spawned.sessionId;
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
        { inputs: moveToken.inputs },
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

  // Send notification if requested
  if (submitResult.notify) {
    console.log(
      `[move-runner] notify requested on channel "${submitResult.notify.channel}": ${submitResult.notify.body}`,
    );
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
    // The session should end — handled by caller
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
 * On startup, scan all moves with `api` + `persist` declarations.
 * For each, read `_registry.json` and re-register handlers from context.ts.
 * Tokens remain stable — the same token that was active before restart
 * continues working after.
 */
async function rehydrateMoveApiRegistry(): Promise<void> {
  // Determine project root — harness runs from harness/, project root is one level up
  const cwd = resolve(import.meta.dir, "..");

  // Collect all move names (builtin + project-local)
  const names = new Set<string>();
  try {
    if (existsSync(BUILTIN_MOVES_DIR)) {
      for (const entry of readdirSync(BUILTIN_MOVES_DIR, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
    const projectDir = join(cwd, MODUS_MOVES_DIR);
    if (existsSync(projectDir)) {
      for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    }
  } catch { /* directories don't exist */ }

  let rehydrated = 0;

  for (const name of names) {
    const config = getMove(name, cwd);
    if (!config?.api || !config.api.state?.persist) continue;

    // State is always stored relative to project CWD (even for builtin moves)
    const registry = readMoveRegistry(cwd, name);
    if (Object.keys(registry).length === 0) continue;

    // Load handlers once per move
    const mod = await loadMoveModule(name, cwd);
    if (!mod?.handlers) {
      console.warn(`[move-runner] rehydrate: ${name} has _registry.json but no handlers in context.ts`);
      continue;
    }

    for (const [token, entry] of Object.entries(registry)) {
      const { instanceId, sessionId } = entry as { instanceId: string; sessionId: string; cwd: string };
      const entryCwd = (entry as any).cwd ?? cwd;

      // Check that state file still exists
      const statePath = join(entryCwd, ".modus/moves", name, "state", `${instanceId}.json`);
      if (!existsSync(statePath)) {
        console.log(`[move-runner] rehydrate: skipping ${name}/${instanceId} — state file missing`);
        continue;
      }

      // Re-register in-memory (skip writeMoveRegistry since it's already persisted)
      moveApiRegistry.set(token, {
        moveName: name,
        instanceId,
        sessionId,
        cwd: entryCwd,
        handlers: mod.handlers,
        persist: true,
      });

      // Load persisted state into memory
      try {
        const raw = readFileSync(statePath, "utf-8");
        moveApiState.set(instanceId, JSON.parse(raw));
      } catch {
        moveApiState.set(instanceId, undefined);
      }

      rehydrated++;
    }
  }

  if (rehydrated > 0) {
    console.log(`[move-runner] rehydrated ${rehydrated} API move instance(s) from disk`);
  }
}

// Run rehydration on module load (harness boot)
rehydrateMoveApiRegistry().catch((err) => {
  console.error("[move-runner] registry rehydration failed:", err);
});

// ── Public API for move run history ──

export { getMoveRuns } from "./move-db";
