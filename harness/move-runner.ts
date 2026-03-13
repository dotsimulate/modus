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

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type {
  MoveConfig, MoveModule, MoveContext, MoveToken,
  ActivateMoveOpts, ActivateMoveResult, SubmitResult,
  MoveDB, HarnessBridge, MoveRun,
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

// ── Move Loading ──

function projectMovesDir(cwd: string): string {
  return join(cwd, MODUS_MOVES_DIR);
}

function resolveMoveLocation(name: string, cwd: string): {
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
    const mod = await import(modulePath);
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
): StartSessionOpts {
  const active = sourceSessionId ? getActiveSession(sourceSessionId) : undefined;
  const explicitProfile = config.agentProfile ?? config.session?.profileOverride ?? undefined;

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

// ── Activate Move ──

export async function activateMove(opts: ActivateMoveOpts): Promise<ActivateMoveResult | { error: string }> {
  const { moveName, sessionId, inputs, cwd, userProfile, modeOverride, forceNewSession } = opts;
  const sourceSessionId = sessionId ?? "";

  // Load move config
  const config = getMove(moveName, cwd);
  if (!config) return { error: `Move not found: ${moveName}` };
  if (config.enabled === false) return { error: `Move is disabled: ${moveName}` };

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
    metadata: { moveName, mode, token },
  });

  // Execute based on mode
  if (mode === "inline") {
    // Inject prompt into current session
    const active = sourceSessionId ? getActiveSession(sourceSessionId) : null;
    if (!sourceSessionId || !active) {
      return { error: `Move "${moveName}" requires an active session` };
    }
    queueMessage(sourceSessionId, prompt);
    return { token, mode, moveRunId };
  }

  if (mode === "branch" || mode === "background") {
    // Spawn a new session with the move prompt
    const spawned = startSession(
      buildSpawnSessionOpts(config, prompt, cwd, userProfile, sourceSessionId),
    );

    // Wait for real session ID
    const start = Date.now();
    while (spawned.sessionId.startsWith("ses-") && Date.now() - start < 8000) {
      await Bun.sleep(100);
    }

    moveToken.spawnedSessionId = spawned.sessionId;

    updateMoveRun(moveRunId, {
      status: "running",
      spawnedSessionId: spawned.sessionId,
    });

    return {
      token,
      mode,
      spawnedSessionId: spawned.sessionId,
      moveRunId,
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

// ── Public API for move run history ──

export { getMoveRuns } from "./move-db";
