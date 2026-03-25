// Prevent nested session detection when launched from within Claude Code
delete process.env.CLAUDECODE;

import { loadSecrets, resolveSecret, isSecretSet, getSecretsInfo, setupPin, changePin } from "./secrets";
loadSecrets();

import { join, resolve, extname } from "path";
import { existsSync } from "fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  getAllProfiles, getProfile, listProfileNames,
  getProfileConfig, getProfileUiConfig, saveProfile, saveProfileUiConfig, patchProfileUiConfig, deleteProfile, getGlobalConfig, saveGlobalConfig,
  setUserName, getUserName,
  getUserProfile, getUserProfileConfig, getUserProfileUiConfig, listUserProfileNames, getAllUserProfiles,
  saveUserProfile, saveUserProfileUiConfig, patchUserProfileUiConfig, deleteUserProfile,
  getUserProfileState, patchUserProfileState,
  listProjects, getProjectById, updateProjectPath,
} from "./profiles";
import { initProject, getInitStatus } from "./init";
import { fetchGeminiUsageSnapshot } from "./gemini-usage";
import { getSessionCommitAttribution } from "./commit-attribution";
import {
  getUiState, listThemes, listFonts, getTheme, getFont, getActiveTheme, getActiveFont,
  registerTheme, registerFont, activateTheme, activateFont, patchTheme, patchFont,
} from "./project-ui";
import {
  listClientExtensions, getClientExtensionById, resolveExtensionSettings,
} from "./client-extensions";
import { getResolvedClientExtensionsConfig } from "./profiles";
import {
  ProfileCoreSchema, ProfileUiSchema,
  UserProfileCoreSchema, UserProfileUiConfigSchema,
  GlobalConfigSchema, validate,
} from "./profile-schemas";
import {
  CreateSessionRequestSchema, SendMessageRequestSchema, UpdateSessionConfigRequestSchema,
  InteractRequestSchema,
} from "./session-schemas";
import {
  listSessions, listSessionsForProjects, listSessionsByAction, listSessionsScoped,
  getSession, getStoredSessionConfig, getLatestSessionUsage, archiveSession, unarchiveSession, listArchivedSessions, searchSessions,
  getEvents, upsertSession as dbUpsertSession,
  getDraft, setDraft, getSessionUiState, patchSessionUiState,
  getWebPositions, upsertWebPositions, deleteWebPositions,
  updateSessionTitle,
  getSessionTags, getSessionByTag, updateSessionTags, addSessionTag, removeSessionTag, parseTags,
  pruneSessionEvents, pruneAllSessionEvents, storageStats, getSessionStats, getPeriodCosts,
  getProviderUsageAnalytics, getDeepAnalytics,
  getSessionMessages, getSessionArtifact,
} from "./db";
import { logActivity, getActivityLog, getActivitySummary } from "./activity";
import { onSessionEvent } from "./action-runner";
import {
  startSession, startSessionWithMoves, queueMessage, steerMessage, stopSession, stopTask,
  getActiveSession, getAllActiveSessions, subscribe, shutdownAll,
  updateSessionConfig, resolvePermission, switchProfile,
  pauseSession, resumeSession, branchSession,
  subscribeGlobal, emitGlobalSessionEvent,
  type SSEWriter,
} from "./session-manager";
import {
  createTerminal, killTerminal, resizeTerminal as resizeTerminalPty,
  getActiveTerminal, getAllActiveTerminals, getTerminalInfo, listAllTerminals,
  shutdownAllTerminals,
} from "./terminal-manager";
import { tryUpgradeTerminalWS, terminalWebSocket, setAuthChecker } from "./terminal-ws";
import { startWatching, subscribeFsEvents, type FsChangeEvent } from "./fs-watcher";

const PORT = Number(process.env.HARNESS_PORT ?? 3777);
const HOST = "0.0.0.0";
const AUTH_TOKEN = process.env.HARNESS_TOKEN || "";
const WHISPER_TRANSCRIBE_URL = "http://127.0.0.1:8080/v1/audio/transcriptions";
const UI_DIST_DIR = resolve(import.meta.dir, "ui/dist");
const UI_INDEX_PATH = join(UI_DIST_DIR, "index.html");
const HARNESS_TLS_CERT = process.env.HARNESS_TLS_CERT;
const HARNESS_TLS_KEY = process.env.HARNESS_TLS_KEY;

const app = new Hono();

function splitProfilePayload(body: Record<string, unknown> | null | undefined): {
  core: Record<string, unknown>;
  ui?: Record<string, unknown>;
} {
  if (!body || typeof body !== "object") return { core: {} };
  const { ui, ...core } = body;
  return ui === undefined ? { core } : { core, ui: ui as Record<string, unknown> };
}

function splitUserProfilePayload(body: Record<string, unknown> | null | undefined): {
  core: Record<string, unknown>;
  ui?: Record<string, unknown>;
} {
  if (!body || typeof body !== "object") return { core: {} };
  const {
    dashboard,
    leftPanel,
    computer,
    editor,
    clientExtensions,
    ...core
  } = body;
  const ui = {
    ...(dashboard !== undefined ? { dashboard } : {}),
    ...(leftPanel !== undefined ? { leftPanel } : {}),
    ...(computer !== undefined ? { computer } : {}),
    ...(editor !== undefined ? { editor } : {}),
    ...(clientExtensions !== undefined ? { clientExtensions } : {}),
  };
  return Object.keys(ui).length > 0 ? { core, ui } : { core };
}

// CORS for all API routes
app.use("/api/*", cors({ origin: "*" }));

// ── PIN Auth (browser gate) ──
// If HARNESS_PIN is set, browsers must verify the PIN to get access.
// Agents using HARNESS_TOKEN (Bearer header) bypass the PIN gate entirely.

/** Dynamic PIN lookup — picks up changes from first-run setup */
function getPin() { return resolveSecret("HARNESS_PIN"); }

// Check if PIN auth is required (no value exposed)
app.get("/api/auth/status", (c) => {
  const pin = getPin();
  return c.json({ required: !!pin, setup: !pin, name: getUserName() });
});

// First-run setup — set PIN from UI, only if none exists yet
app.post("/api/auth/setup", async (c) => {
  if (getPin()) return c.json({ error: "pin already set" }, 403);
  const body = await c.req.json();
  const pin = body.pin?.trim();
  const name = body.name?.trim();
  if (!pin || pin.length < 4) return c.json({ error: "pin must be at least 4 characters" }, 400);
  const ok = setupPin(pin);
  if (!ok) return c.json({ error: "pin already set" }, 403);
  const sessionToken = crypto.randomUUID();
  pinSessions.add(sessionToken);
  if (name) setUserName(name);
  return c.json({ ok: true, token: sessionToken });
});

// Verify PIN — returns a session token for the browser
app.post("/api/auth/verify", async (c) => {
  const pin = getPin();
  if (!pin) return c.json({ ok: true, token: "" });
  const body = await c.req.json();
  if (body.pin === pin) {
    const sessionToken = crypto.randomUUID();
    pinSessions.add(sessionToken);
    const name = body.name?.trim();
    if (name) setUserName(name);
    return c.json({ ok: true, token: sessionToken });
  }
  return c.json({ error: "wrong pin" }, 401);
});

// Get current user display name
app.get("/api/auth/me", (c) => {
  return c.json({ name: getUserName() });
});

// In-memory set of valid browser session tokens from PIN auth
const pinSessions = new Set<string>();

// Lock — invalidate ALL browser sessions (agents unaffected)
app.post("/api/auth/lock", (c) => {
  pinSessions.clear();
  return c.json({ ok: true });
});

// Change PIN — requires old PIN to verify identity
app.post("/api/auth/change-pin", async (c) => {
  const body = await c.req.json();
  const oldPin = body.oldPin?.trim();
  const newPin = body.newPin?.trim();
  if (!oldPin || !newPin) return c.json({ error: "oldPin and newPin are required" }, 400);
  if (newPin.length < 4) return c.json({ error: "new PIN must be at least 4 characters" }, 400);
  const ok = changePin(oldPin, newPin);
  if (!ok) return c.json({ error: "wrong PIN" }, 401);
  return c.json({ ok: true });
});

// Token auth — skip if no HARNESS_TOKEN is set
// Also allows PIN-derived session tokens
app.use("/api/*", async (c, next) => {
  // Auth endpoints are always open
  if (c.req.path.startsWith("/api/auth/")) return next();

  // Webhook action endpoints use their own token auth (action-level, not harness-level)
  if (/^\/api\/actions\/[^/]+\/hook$/.test(c.req.path)) return next();

  // If neither HARNESS_TOKEN nor HARNESS_PIN is set, no auth at all
  if (!AUTH_TOKEN && !getPin()) return next();

  const header = c.req.header("Authorization");
  const tokenParam = new URL(c.req.url).searchParams.get("token");
  const bearerToken = header?.startsWith("Bearer ") ? header.slice(7) : null;

  // Agent auth: HARNESS_TOKEN (always takes priority)
  if (AUTH_TOKEN && (bearerToken === AUTH_TOKEN || tokenParam === AUTH_TOKEN)) {
    return next();
  }

  // Browser auth: PIN session token
  if (bearerToken && pinSessions.has(bearerToken)) return next();
  if (tokenParam && pinSessions.has(tokenParam)) return next();

  return c.json({ error: "unauthorized" }, 401);
});

// ── Health ──

app.get("/health", (c) => {
  const all = getAllActiveSessions();
  const running = all.filter(s => s.status === "running" || s.status === "starting");
  return c.json({ status: "ok", uptime: process.uptime(), activeSessions: running.length });
});

// ── Admin ──

app.post("/api/admin/restart", async (c) => {
  // Requires HARNESS_TOKEN — agents only, not browser PIN sessions
  const header = c.req.header("Authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!AUTH_TOKEN || bearer !== AUTH_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const { force = false } = await c.req.json().catch(() => ({}));

  const active = getAllActiveSessions();
  if (!force && active.length > 0) {
    return c.json({
      error: "active sessions",
      sessions: active.map(s => s.sessionId),
      hint: "use force:true to restart anyway"
    }, 409);
  }

  // Write sentinel file — watchdog sees this and does a clean restart (no backoff)
  const sentinelPath = join(import.meta.dir, ".watchdog-restart");
  await Bun.write(sentinelPath, Date.now().toString());

  // Respond before shutting down
  const response = c.json({ ok: true, restarting: true });

  // Shut down after response flushes (~100ms)
  setTimeout(async () => {
    shutdownAll();
    await Bun.sleep(200);
    process.exit(0);
  }, 100);

  return response;
});

// ── Profiles ──

app.get("/api/profiles", (c) => {
  const cwd = c.req.query("cwd");
  const all = getAllProfiles(cwd);
  const list = Object.entries(all).map(([name, p]) => ({
    name,
    ...p,
    tools: p.tools ?? "all",
  }));
  return c.json(list);
});

app.get("/api/profiles/_global", (c) => {
  const cwd = c.req.query("cwd");
  return c.json(getGlobalConfig(cwd));
});

app.put("/api/profiles/_global", async (c) => {
  const cwd = c.req.query("cwd");
  const body = await c.req.json();
  const v = validate(GlobalConfigSchema, body);
  if (!v.ok) return c.json({ error: "validation failed", details: v.errors }, 400);
  saveGlobalConfig(body, cwd);
  return c.json({ ok: true });
});

app.get("/api/profiles/:name", (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  const profile = getProfile(name, cwd);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  return c.json({ name, ...profile });
});

app.put("/api/profiles/:name", async (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  if (name.startsWith("_")) return c.json({ error: "reserved name" }, 400);
  const body = await c.req.json<Record<string, unknown>>();
  const { core, ui } = splitProfilePayload(body);
  const coreValidation = validate(ProfileCoreSchema, core);
  if (!coreValidation.ok) return c.json({ error: "validation failed", details: coreValidation.errors }, 400);
  if (ui !== undefined) {
    const uiValidation = validate(ProfileUiSchema, ui);
    if (!uiValidation.ok) return c.json({ error: "validation failed", details: uiValidation.errors }, 400);
  }
  saveProfile(name, core as any, cwd);
  if (ui !== undefined) {
    saveProfileUiConfig(name, { ...(getProfileUiConfig(name, cwd) ?? {}), ...ui } as any, cwd);
  }
  return c.json({ ok: true, name });
});

app.get("/api/profiles/:name/ui-config", (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  const profile = getProfileConfig(name, cwd);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  return c.json(getProfileUiConfig(name, cwd) ?? {});
});

app.patch("/api/profiles/:name/ui-config", async (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  const profile = getProfileConfig(name, cwd);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const next = { ...(getProfileUiConfig(name, cwd) ?? {}), ...body };
  const v = validate(ProfileUiSchema, next);
  if (!v.ok) return c.json({ error: "validation failed", details: v.errors }, 400);
  return c.json(patchProfileUiConfig(name, body as any, cwd));
});

app.delete("/api/profiles/:name", (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  const deleted = deleteProfile(name, cwd);
  if (!deleted) return c.json({ error: "profile not found" }, 404);
  return c.json({ ok: true });
});

// ── User Profiles ──

app.get("/api/user-profiles", (c) => {
  const all = getAllUserProfiles();
  const list = Object.entries(all).map(([name, p]) => ({ name, ...p }));
  return c.json(list);
});

app.get("/api/user-profiles/:name", (c) => {
  const name = c.req.param("name");
  const profile = getUserProfile(name);
  if (!profile) return c.json({ error: "user profile not found" }, 404);
  return c.json({ name, ...profile });
});

app.put("/api/user-profiles/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json<Record<string, unknown>>();
  const { core, ui } = splitUserProfilePayload(body);
  const coreValidation = validate(UserProfileCoreSchema, core);
  if (!coreValidation.ok) return c.json({ error: "validation failed", details: coreValidation.errors }, 400);
  if (ui !== undefined) {
    const uiValidation = validate(UserProfileUiConfigSchema, ui);
    if (!uiValidation.ok) return c.json({ error: "validation failed", details: uiValidation.errors }, 400);
  }
  saveUserProfile(name, core as any);
  if (ui !== undefined) {
    saveUserProfileUiConfig(name, { ...(getUserProfileUiConfig(name) ?? {}), ...ui } as any);
  }
  return c.json({ ok: true, name });
});

app.patch("/api/user-profiles/:name", async (c) => {
  const name = c.req.param("name");
  const existing = getUserProfileConfig(name);
  if (!existing) return c.json({ error: "user profile not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const { core, ui } = splitUserProfilePayload(body);
  const nextCore = { ...existing, ...core };
  const coreValidation = validate(UserProfileCoreSchema, nextCore);
  if (!coreValidation.ok) return c.json({ error: "validation failed after merge", details: coreValidation.errors }, 400);
  if (ui !== undefined) {
    const nextUi = { ...(getUserProfileUiConfig(name) ?? {}), ...ui };
    const uiValidation = validate(UserProfileUiConfigSchema, nextUi);
    if (!uiValidation.ok) return c.json({ error: "validation failed after merge", details: uiValidation.errors }, 400);
    patchUserProfileUiConfig(name, ui as any);
  }
  saveUserProfile(name, nextCore as any);
  return c.json({ ok: true, name, ...(getUserProfile(name) ?? nextCore) });
});

app.get("/api/user-profiles/:name/ui-config", (c) => {
  const name = c.req.param("name");
  const profile = getUserProfileConfig(name);
  if (!profile) return c.json({ error: "user profile not found" }, 404);
  return c.json(getUserProfileUiConfig(name) ?? {});
});

app.patch("/api/user-profiles/:name/ui-config", async (c) => {
  const name = c.req.param("name");
  const profile = getUserProfileConfig(name);
  if (!profile) return c.json({ error: "user profile not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const next = { ...(getUserProfileUiConfig(name) ?? {}), ...body };
  const v = validate(UserProfileUiConfigSchema, next);
  if (!v.ok) return c.json({ error: "validation failed", details: v.errors }, 400);
  return c.json(patchUserProfileUiConfig(name, body as any));
});

app.delete("/api/user-profiles/:name", (c) => {
  const name = c.req.param("name");
  const deleted = deleteUserProfile(name);
  if (!deleted) return c.json({ error: "user profile not found" }, 404);
  return c.json({ ok: true });
});

// ── User Profile State (runtime UI state, separate from config) ──

app.get("/api/user-profiles/:name/state", (c) => {
  const name = c.req.param("name");
  return c.json(getUserProfileState(name));
});

app.patch("/api/user-profiles/:name/state", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const updated = patchUserProfileState(name, body);
  return c.json(updated);
});

// ── Secrets Status (booleans only, no values) ──

app.post("/api/secrets/check", async (c) => {
  const { vars } = await c.req.json<{ vars: string[] }>();
  if (!Array.isArray(vars)) return c.json({ error: "vars must be an array" }, 400);
  const status: Record<string, boolean> = {};
  for (const v of vars) {
    if (typeof v === "string") status[v] = isSecretSet(v);
  }
  const info = getSecretsInfo();
  return c.json({ status, secretsFile: info.path });
});

// ── Providers ──

app.get("/api/providers", async (c) => {
  const { listProviders } = await import("./providers/registry");
  return c.json(listProviders());
});

app.get("/api/provider-capabilities", async (c) => {
  const { listProviderCapabilities } = await import("./providers/registry");
  return c.json(listProviderCapabilities());
});

app.get("/api/provider-health", async (c) => {
  const { checkAllProviderHealth } = await import("./providers/registry");
  return c.json(await checkAllProviderHealth());
});

app.get("/api/providers/:name/models", async (c) => {
  const { fetchProviderModels } = await import("./providers/models");
  const name = c.req.param("name");
  try {
    const models = await fetchProviderModels(name);
    return c.json(models);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// ── Sessions ──

/** Resolve user profile scoping from query param */
function resolveUserProfileScope(c: any): { cwdPrefixes?: string[]; agentProfiles?: string[] } | undefined {
  const profileName = new URL(c.req.url).searchParams.get("userProfile");
  if (!profileName) return undefined;
  const profile = getUserProfile(profileName);
  if (!profile) return undefined;
  return {
    cwdPrefixes: profile.projects?.length ? profile.projects : undefined,
    agentProfiles: profile.agentProfiles?.length ? profile.agentProfiles : undefined,
  };
}

app.get("/api/sessions/search", (c) => {
  const params = new URL(c.req.url).searchParams;
  const q = params.get("q")?.trim();
  if (!q) return c.json([]);
  const limit = Number(params.get("limit") ?? 20);
  const scope = resolveUserProfileScope(c);
  return c.json(searchSessions(q, limit, {
    cwdPrefixes: scope?.cwdPrefixes,
    agentProfiles: scope?.agentProfiles,
    userProfileName: params.get("userProfile") ?? undefined,
  }));
});

app.get("/api/sessions", (c) => {
  const params = new URL(c.req.url).searchParams;
  const limit = Number(params.get("limit") ?? 50);
  const actionFilter = params.get("action");
  const profileFilter = params.get("profile");
  const scope = resolveUserProfileScope(c);
  const userProfileName = new URL(c.req.url).searchParams.get("userProfile") ?? undefined;
  const rows = actionFilter
    ? listSessionsByAction(actionFilter, limit)
    : profileFilter
      ? listSessionsScoped({ agentProfiles: [profileFilter], userProfileName, limit })
      : scope
        ? listSessionsScoped({ ...scope, limit })
        : listSessions(limit);
  // Correct stale statuses: if DB says running/starting/idle but session
  // is not actually active in memory, it's done.
  const corrected = rows.map((s) => {
    const storedConfig = s.provider ? null : getStoredSessionConfig(s.id);
    const provider = s.provider ?? storedConfig?.provider ?? null;
    const usage = getLatestSessionUsage(s.id, provider);
    if ((s.status === "running" || s.status === "starting" || s.status === "idle" || s.status === "paused") && !getActiveSession(s.id)) {
      return {
        ...s,
        provider,
        status: "done",
        last_input_tokens: usage?.inputTokens ?? null,
        last_output_tokens: usage?.outputTokens ?? null,
      };
    }
    return {
      ...s,
      provider,
      last_input_tokens: usage?.inputTokens ?? null,
      last_output_tokens: usage?.outputTokens ?? null,
    };
  });
  return c.json(corrected);
});

app.get("/api/sessions/active", (c) => {
  const scope = resolveUserProfileScope(c);
  const memSessions = getAllActiveSessions().map((s) => {
    const dbRow = getSession(s.sessionId);
    return {
      id: s.sessionId,
      status: s.status,
      profile: s.profile ?? null,
      provider: s.provider,
      model: s.model ?? null,
      costUsd: s.costUsd,
      numTurns: s.numTurns,
      startedAt: s.startedAt,
      lastEventAt: s.lastEventAt,
      preview: s.preview,
      lastText: s.lastAssistantText || null,
      seq: s.seq,
      subscribers: s.subscribers.size,
      cwd: s.cwd ?? null,
      additionalDirectories: s.additionalDirectories.length > 0 ? s.additionalDirectories : null,
      archived: dbRow?.archived === 1,
    };
  });
  // Apply user profile scoping server-side
  const filtered = scope
    ? (!scope.cwdPrefixes && !scope.agentProfiles)
      ? []  // profile has no projects and no agents → show nothing
      : memSessions.filter((s) => {
          if (scope.agentProfiles && s.profile && !scope.agentProfiles.includes(s.profile)) return false;
          if (scope.cwdPrefixes && s.cwd && !scope.cwdPrefixes.some((p) => s.cwd!.startsWith(p))) return false;
          return true;
        })
    : memSessions;
  return c.json(filtered);
});

// Create new session
app.post("/api/sessions", async (c) => {
  const body = await c.req.json();
  const v = validate(CreateSessionRequestSchema, body);
  if (!v.ok) return c.json({ error: "invalid session request", details: v.errors }, 400);
  const { prompt } = body;
  const resolvedCwd = body.cwd ?? process.env.AGENT_CWD ?? process.cwd();

  if (body.profile && !getProfile(body.profile, resolvedCwd)) {
    return c.json(
      { error: `unknown profile: ${body.profile}`, available: listProfileNames(resolvedCwd) },
      400,
    );
  }

  const sessionOpts = {
    prompt,
    attachments: body.attachments,
    profile: body.profile,
    userProfile: body.userProfile,
    provider: body.provider,
    model: body.model,
    toolStates: body.toolStates,
    maxTurns: body.maxTurns,
    effort: body.effort,
    cwd: resolvedCwd,
    additionalDirectories: body.additionalDirectories,
    tools: body.tools,
    disallowedTools: body.disallowedTools,
    providerControls: body.providerControls,
    loadProjectSettings: body.loadProjectSettings,
    sessionId: body.sessionId, // for resume
  };

  // Use startSessionWithMoves — handles profile move bindings automatically.
  // For profiles without moves, this is equivalent to startSession + ID wait.
  const session = await startSessionWithMoves(sessionOpts);

  return c.json({
    sessionId: session.sessionId,
    status: session.status,
  });
});

// ── Canonical interaction endpoint ──
// One call to create-or-resume a session, send a prompt (with optional moves),
// and optionally subscribe to the SSE event stream.
app.post("/api/sessions/interact", async (c) => {
  const body = await c.req.json();
  const v = validate(InteractRequestSchema, body);
  if (!v.ok) return c.json({ error: "invalid interact request", details: v.errors }, 400);

  const { prompt, sessionId, moves, attachments } = body;
  const shouldSubscribe = body.subscribe !== false;
  const createIfMissing = body.createIfMissing !== false;
  const resolvedCwd = body.cwd ?? process.env.AGENT_CWD ?? process.cwd();
  // Map permissionMode to internal permissionPolicy (undefined = use profile default)
  const permissionPolicy = body.permissionMode === "bypass" ? "bypass" as const : undefined;

  // Validate profile if provided
  if (body.profile && !getProfile(body.profile, resolvedCwd)) {
    return c.json(
      { error: `unknown profile: ${body.profile}`, available: listProfileNames(resolvedCwd) },
      400,
    );
  }

  let targetSessionId: string | undefined = sessionId;

  if (sessionId) {
    const active = getActiveSession(sessionId);
    if (active) {
      // Session active — queue the message
      queueMessage(sessionId, prompt, attachments, moves);
    } else {
      // Session exists in DB but not active — resume it
      const existing = getSession(sessionId);
      if (!existing && !createIfMissing) {
        return c.json({ error: `session not found: ${sessionId}` }, 404);
      }

      const storedConfig = existing ? getStoredSessionConfig(sessionId) : undefined;
      const session = await startSessionWithMoves({
        prompt,
        attachments,
        sessionId,
        cwd: body.cwd ?? storedConfig?.cwd ?? existing?.cwd ?? resolvedCwd,
        additionalDirectories: body.additionalDirectories ?? storedConfig?.additionalDirectories,
        profile: body.profile ?? existing?.profile ?? undefined,
        userProfile: body.userProfile,
        provider: body.provider ?? storedConfig?.provider,
        model: body.model ?? storedConfig?.model ?? existing?.model ?? undefined,
        effort: body.effort ?? storedConfig?.effort,
        maxTurns: body.maxTurns ?? storedConfig?.maxTurns,
        tools: body.tools ?? storedConfig?.tools,
        disallowedTools: body.disallowedTools ?? storedConfig?.disallowedTools,
        toolStates: body.toolStates ?? storedConfig?.toolStates,
        providerControls: body.providerControls ?? storedConfig?.providerControls,
        loadProjectSettings: body.loadProjectSettings ?? storedConfig?.loadProjectSettings,
        permissionPolicy,
      });
      targetSessionId = session.sessionId;
    }
  } else {
    // No sessionId — create a new session
    if (!createIfMissing) {
      return c.json({ error: "sessionId required when createIfMissing is false" }, 400);
    }

    const session = await startSessionWithMoves({
      prompt,
      attachments,
      profile: body.profile,
      userProfile: body.userProfile,
      provider: body.provider,
      model: body.model,
      toolStates: body.toolStates,
      maxTurns: body.maxTurns,
      effort: body.effort,
      cwd: resolvedCwd,
      additionalDirectories: body.additionalDirectories,
      tools: body.tools,
      disallowedTools: body.disallowedTools,
      providerControls: body.providerControls,
      loadProjectSettings: body.loadProjectSettings,
      permissionPolicy,
    });
    targetSessionId = session.sessionId;
    // Note: per-request moves on new sessions are not yet supported —
    // profile moves are activated by startSessionWithMoves automatically.
    // Per-request moves work on subsequent messages via queueMessage.
  }

  if (shouldSubscribe) {
    return streamSessionSSE(c, targetSessionId!, 0);
  }

  return c.json({ sessionId: targetSessionId, status: getActiveSession(targetSessionId!)?.status ?? "starting" });
});

// Create empty session (DB row only, no SDK). Used by "new session" button.
app.post("/api/sessions/empty", async (c) => {
  const body = await c.req.json();
  const id = crypto.randomUUID();
  dbUpsertSession({
    id,
    preview: "",
    profile: body.profile ?? null,
    provider: body.provider ?? null,
    model: body.model ?? null,
    status: "idle",
    messageCount: 0,
    costUsd: 0,
    cwd: body.cwd ?? null,
    userProfile: body.userProfile ?? null,
  });
  emitGlobalSessionEvent({
    type: "session:created",
    sessionId: id,
    status: "idle",
    profile: body.profile ?? undefined,
    userProfile: body.userProfile ?? undefined,
  });
  return c.json({ sessionId: id });
});

// Get session status
app.get("/api/sessions/:id/status", async (c) => {
  const id = c.req.param("id");
  const active = getActiveSession(id);
  if (active) {
    const dbRow = getSession(active.sessionId);
    const commitAttribution = await getSessionCommitAttribution(active.sessionId);
    return c.json({
      sessionId: active.sessionId,
      status: active.status,
      seq: active.seq,
      costUsd: active.costUsd,
      numTurns: active.numTurns,
      startedAt: active.startedAt,
      lastEventAt: active.lastEventAt,
      error: active.error,
      archived: dbRow?.archived === 1,
      commitAttribution,
    });
  }
  // Check DB for completed session
  const dbSession = getSession(id);
  if (dbSession) {
    const commitAttribution = await getSessionCommitAttribution(id);
    return c.json({
      sessionId: dbSession.id,
      status: dbSession.status,
      seq: 0,
      costUsd: dbSession.total_cost_usd,
      numTurns: dbSession.message_count,
      startedAt: dbSession.created_at,
      lastEventAt: dbSession.updated_at,
      error: null,
      archived: dbSession.archived === 1,
      commitAttribution,
    });
  }
  return c.json({ error: "session not found" }, 404);
});

// ── Shared SSE streaming helper ──
// Used by both GET /api/sessions/:id/events and POST /api/sessions/interact
function streamSessionSSE(c: any, sessionId: string, afterSeq = 0) {
  return streamSSE(c, async (stream: any) => {
    // Send catch-up events from DB
    const pastEvents = getEvents(sessionId, afterSeq);
    for (const evt of pastEvents) {
      let data = evt.data;
      try { data = JSON.stringify({ ...JSON.parse(evt.data), _ts: evt.created_at }); } catch {}
      await stream.writeSSE({ event: evt.type, data, id: String(evt.seq) });
    }

    // If session is still active, subscribe for live events
    const active = getActiveSession(sessionId);
    if (active && active.status !== "done" && active.status !== "error") {
      let resolve: () => void;
      const done = new Promise<void>((r) => { resolve = r; });

      const keepAlive = setInterval(async () => {
        try { await stream.writeSSE({ event: "ping", data: "{}", id: "" }); } catch { /* connection dead */ }
      }, 30_000);

      const writer: SSEWriter = {
        async write(event: string, data: string, seqId: string) {
          await stream.writeSSE({ event, data, id: seqId });
          if (event === "done") resolve();
        },
        close() { resolve(); },
      };

      const unsubscribe = subscribe(sessionId, writer);
      stream.onAbort(() => { clearInterval(keepAlive); unsubscribe(); resolve(); });

      await done;
      clearInterval(keepAlive);
    } else {
      await stream.writeSSE({ event: "done", data: "{}", id: "done" });
    }
  });
}

// Subscribe to session events (SSE)
app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  const afterSeq = Number(new URL(c.req.url).searchParams.get("after") ?? 0);
  return streamSessionSSE(c, id, afterSeq);
});

// Global session lifecycle events (SSE) — used by SessionWeb for real-time updates
app.get("/api/events/sessions", (c) => {
  return streamSSE(c, async (stream) => {
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    const keepAlive = setInterval(async () => {
      try { await stream.writeSSE({ event: "ping", data: "{}", id: "" }); } catch { /* dead */ }
    }, 30_000);

    const writer = {
      async write(data: string) {
        await stream.writeSSE({ event: "session", data, id: String(Date.now()) });
      },
      close() { resolve(); },
    };

    const unsubscribe = subscribeGlobal(writer);
    stream.onAbort(() => { clearInterval(keepAlive); unsubscribe(); resolve(); });

    await done;
    clearInterval(keepAlive);
  });
});

// ── Filesystem change events (SSE) — used by FileBrowser and FileViewer for live refresh ──
app.get("/api/events/fs", (c) => {
  // Optional: start watching a specific root (defaults to whatever is already being watched)
  const watchPath = new URL(c.req.url).searchParams.get("root");
  if (watchPath) startWatching(watchPath);

  return streamSSE(c, async (stream) => {
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });

    const keepAlive = setInterval(async () => {
      try { await stream.writeSSE({ event: "ping", data: "{}", id: "" }); } catch { /* dead */ }
    }, 30_000);

    const unsub = subscribeFsEvents({
      write(event: FsChangeEvent) {
        stream.writeSSE({
          event: "fs",
          data: JSON.stringify(event),
          id: String(Date.now()),
        }).catch(() => {});
      },
      close() { resolve(); },
    });

    stream.onAbort(() => { clearInterval(keepAlive); unsub(); resolve(); });

    await done;
    clearInterval(keepAlive);
  });
});

// Get reconstructed message content for a session (from events)
app.get("/api/sessions/:id/messages-content", (c) => {
  const id = c.req.param("id");
  const seq = c.req.query("seq");
  const messages = getSessionMessages(id);
  if (seq) {
    const seqNum = Number(seq);
    const msg = messages.find(m => m.seq === seqNum);
    if (!msg) return c.json({ error: "message not found" }, 404);
    return c.json(msg);
  }
  return c.json(messages);
});

app.get("/api/sessions/:id/artifacts/:artifactId", async (c) => {
  const sessionId = c.req.param("id");
  const artifactId = Number(c.req.param("artifactId"));
  if (!Number.isFinite(artifactId) || artifactId <= 0) {
    return c.json({ error: "invalid artifact id" }, 400);
  }
  const artifact = getSessionArtifact(sessionId, artifactId);
  if (!artifact) return c.json({ error: "artifact not found" }, 404);
  const file = Bun.file(artifact.path);
  if (!(await file.exists())) return c.json({ error: "artifact file not found" }, 404);
  const size = file.size;
  const rangeHeader = c.req.header("Range");

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      const chunk = file.slice(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          "Content-Type": artifact.mime,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  return new Response(file, {
    headers: {
      "Content-Type": artifact.mime,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
});

// Queue a message into a running/idle session
app.post("/api/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const v = validate(SendMessageRequestSchema, body);
  if (!v.ok) return c.json({ error: "invalid message request", details: v.errors }, 400);
  const { prompt } = body;

  const active = getActiveSession(id);
  if (!active) {
    // Session not active in memory — resume it via SDK
    const existing = getSession(id);
    const storedConfig = getStoredSessionConfig(id);
    const session = startSession({
      prompt,
      attachments: body.attachments,
      sessionId: id,
      cwd: body.cwd ?? storedConfig?.cwd ?? existing?.cwd ?? undefined,
      additionalDirectories: body.additionalDirectories ?? storedConfig?.additionalDirectories,
      profile: body.profile ?? existing?.profile ?? undefined,
      userProfile: body.userProfile,
      provider: body.provider ?? storedConfig?.provider,
      model: body.model ?? storedConfig?.model ?? existing?.model ?? undefined,
      effort: body.effort ?? storedConfig?.effort,
      maxTurns: body.maxTurns ?? storedConfig?.maxTurns,
      tools: body.tools ?? storedConfig?.tools,
      disallowedTools: body.disallowedTools ?? storedConfig?.disallowedTools,
      toolStates: body.toolStates ?? storedConfig?.toolStates,
      providerControls: body.providerControls ?? storedConfig?.providerControls,
      loadProjectSettings: body.loadProjectSettings ?? storedConfig?.loadProjectSettings,
    });
    const start = Date.now();
    while (session.sessionId.startsWith("pending-") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return c.json({ queued: true, status: session.status, sessionId: session.sessionId });
  }

  const queued = queueMessage(id, prompt, body.attachments, body.moves);
  return c.json({ queued, status: active.status });
});

// Steer: inject a message at the next tool boundary (falls back to queue if unsupported)
app.post("/api/sessions/:id/steer", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  const ok = steerMessage(id, prompt, body.attachments);
  return c.json({ ok });
});

// Stop session entirely
app.post("/api/sessions/:id/stop", (c) => {
  const ok = stopSession(c.req.param("id"));
  return c.json({ ok });
});

// Stop a subagent task
app.post("/api/sessions/:id/stop-task", async (c) => {
  const body = await c.req.json();
  const ok = stopTask(c.req.param("id"), body.taskId);
  return c.json({ ok });
});

// Pause a running/idle session at the next tool boundary
app.post("/api/sessions/:id/pause", (c) => {
  const result = pauseSession(c.req.param("id"));
  if (!result.ok) return c.json({ error: "session not found or cannot be paused" }, 404);
  return c.json({ ok: true, status: result.status });
});

// Resume a paused session
app.post("/api/sessions/:id/resume", (c) => {
  const result = resumeSession(c.req.param("id"));
  if (!result.ok) return c.json({ error: "session not found" }, 404);
  return c.json({ ok: true, status: result.status });
});

// Respond to a permission request (approve/deny from UI)
app.post("/api/sessions/:id/permission-response", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { requestId, behavior, updatedInput, message, scope } = body;
  if (!requestId || !behavior) return c.json({ error: "requestId and behavior required" }, 400);
  const ok = resolvePermission(id, requestId, { behavior, updatedInput, message, scope });
  return ok ? c.json({ ok: true }) : c.json({ error: "permission request not found" }, 404);
});

// Update session config (tools, etc.) — takes effect on next turn
app.patch("/api/sessions/:id/config", async (c) => {
  const body = await c.req.json();
  const v = validate(UpdateSessionConfigRequestSchema, body);
  if (!v.ok) return c.json({ error: "invalid session config", details: v.errors }, 400);
  const ok = updateSessionConfig(c.req.param("id"), body);
  return ok ? c.json({ ok: true }) : c.json({ error: "session not found" }, 404);
});

// Switch active profile on a running/idle session
app.patch("/api/sessions/:id/profile", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { profile, contextMode } = body;
  if (!profile) return c.json({ error: "profile required" }, 400);
  const active = getActiveSession(id);
  const sessionCwd = active?.cwd ?? getSession(id)?.cwd ?? undefined;
  if (!getProfile(profile, sessionCwd)) {
    return c.json(
      { error: `unknown profile: ${profile}`, available: listProfileNames(sessionCwd) },
      400,
    );
  }
  const fromProfile = active?.profile;
  const ok = await switchProfile(id, profile, { contextMode });
  if (!ok) return c.json({ error: "session not found or switch failed" }, 404);
  logActivity({
    eventType: "profile_switch",
    sessionId: id,
    agentProfile: profile,
    userProfile: active?.userProfile,
    summary: `Profile switched: ${fromProfile ?? "none"} -> ${profile}`,
    metadata: { fromProfile, toProfile: profile, contextMode },
  });
  return c.json({ ok: true, profile });
});

// Archive session (soft-delete — preserves data in DB)
app.delete("/api/sessions/:id", (c) => {
  const id = c.req.param("id");
  // Stop if active
  stopSession(id);
  const dbRow = getSession(id);
  archiveSession(id);
  emitGlobalSessionEvent({ type: "session:archived", sessionId: id });
  // Emit session trigger for "archived" event
  if (dbRow) {
    onSessionEvent("archived", {
      id,
      userProfile: dbRow.user_profile ?? undefined,
      tags: [...parseTags(dbRow.tags), "archived"],
      preview: dbRow.preview,
      title: dbRow.title,
      messageCount: dbRow.message_count,
    });
  }
  return c.json({ ok: true });
});

// List archived sessions (ordered by most recently archived)
app.get("/api/sessions/archived", (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 50);
  return c.json(listArchivedSessions(limit));
});

// Unarchive a session — restore it to the active list
app.post("/api/sessions/:id/unarchive", (c) => {
  const id = c.req.param("id");
  unarchiveSession(id);
  return c.json({ ok: true });
});

// Rename session (set/clear title)
app.patch("/api/sessions/:id/title", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const title = typeof body.title === "string" ? body.title.trim() || null : null;
  updateSessionTitle(id, title);
  return c.json({ ok: true, title });
});

// Session tags — get, set, add, remove
app.get("/api/sessions/:id/tags", (c) => {
  const tags = getSessionTags(c.req.param("id"));
  return c.json({ tags });
});

app.patch("/api/sessions/:id/tags", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (Array.isArray(body.tags)) {
    // Replace all tags
    updateSessionTags(id, body.tags.filter((t: any) => typeof t === "string"));
  } else if (typeof body.add === "string") {
    addSessionTag(id, body.add.toLowerCase().trim());
  } else if (typeof body.remove === "string") {
    removeSessionTag(id, body.remove.toLowerCase().trim());
  } else {
    return c.json({ error: "provide tags (array), add (string), or remove (string)" }, 400);
  }
  return c.json({ ok: true, tags: getSessionTags(id) });
});

// Look up session by tag — returns most recent non-archived session with this tag
app.get("/api/sessions/by-tag/:tag", (c) => {
  const tag = decodeURIComponent(c.req.param("tag"));
  const row = getSessionByTag(tag);
  if (!row) return c.json({ error: "no session with that tag" }, 404);
  return c.json({ id: row.id, status: row.status, profile: row.profile, tags: parseTags(row.tags), createdAt: row.created_at, updatedAt: row.updated_at });
});

// Branch session — fork from a specific point in a past conversation
app.post("/api/sessions/:id/branch", async (c) => {
  const sourceId = c.req.param("id");
  const body = await c.req.json();
  const { seq } = body;
  if (typeof seq !== "number" || seq < 1) return c.json({ error: "seq required (positive integer)" }, 400);
  const result = branchSession(sourceId, seq);
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json({ sessionId: result.sessionId });
});

// ── Draft Text ──
// Persists unsent user input per session — syncs across devices.

app.get("/api/sessions/:id/draft", (c) => {
  const text = getDraft(c.req.param("id"));
  return c.json({ draft: text });
});

app.put("/api/sessions/:id/draft", async (c) => {
  const body = await c.req.json();
  setDraft(c.req.param("id"), body.draft ?? "");
  return c.json({ ok: true });
});

app.get("/api/ui/sessions/:id/draft", (c) => {
  const text = getDraft(c.req.param("id"));
  return c.json({ draft: text });
});

app.put("/api/ui/sessions/:id/draft", async (c) => {
  const body = await c.req.json();
  setDraft(c.req.param("id"), body.draft ?? "");
  return c.json({ ok: true });
});

// ── Session UI State ──
// Persists per-session UI layout (panel widths, open/closed state, etc.)

app.get("/api/sessions/:id/ui-state", (c) => {
  return c.json(getSessionUiState(c.req.param("id")));
});

app.patch("/api/sessions/:id/ui-state", async (c) => {
  const body = await c.req.json();
  const updated = patchSessionUiState(c.req.param("id"), body);
  return c.json(updated);
});

app.get("/api/ui/sessions/:id/state", (c) => {
  return c.json(getSessionUiState(c.req.param("id")));
});

app.patch("/api/ui/sessions/:id/state", async (c) => {
  const body = await c.req.json();
  const updated = patchSessionUiState(c.req.param("id"), body);
  return c.json(updated);
});

// ── Directory Browser ──
// Lists subdirectories at a given path for the CWD folder picker.
app.get("/api/browse", async (c) => {
  const { homedir } = await import("os");
  const params = new URL(c.req.url).searchParams;
  const raw = params.get("path") ?? homedir();
  const includeHidden = params.get("includeHidden") === "1";
  // Resolve and sanitize — no traversal tricks
  const { resolve } = await import("path");
  const { readdir, stat } = await import("fs/promises");
  const target = resolve(raw);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return c.json({ error: "not a directory" }, 400);
    const entries = await readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const includeFiles = params.get("includeFiles") === "1";
    const files = includeFiles
      ? entries
          .filter((e) => e.isFile() && (includeHidden || !e.name.startsWith(".")))
          .map((e) => e.name)
          .sort()
      : undefined;
    // Also provide parent for navigation
    const parent = resolve(target, "..");
    return c.json({ path: target, parent: parent !== target ? parent : null, dirs, ...(files ? { files } : {}) });
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "not found" : err.message }, 400);
  }
});

// ── File Reader ──
// Read a single file's text content by absolute path.
app.get("/api/file-read", async (c) => {
  const raw = new URL(c.req.url).searchParams.get("path");
  if (!raw) return c.json({ error: "path required" }, 400);
  const { resolve } = await import("path");
  const { readFile } = await import("fs/promises");
  const target = resolve(raw);
  try {
    const content = await readFile(target, "utf-8");
    return c.json({ path: target, content });
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "not found" : err.message }, 400);
  }
});

app.get("/api/file-serve", async (c) => {
  const raw = new URL(c.req.url).searchParams.get("path");
  if (!raw) return c.json({ error: "path required" }, 400);
  const { resolve, extname } = await import("path");
  const target = resolve(raw);
  const file = Bun.file(target);
  if (!(await file.exists())) return c.json({ error: "not found" }, 400);
  const ext = extname(target).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".webp": "image/webp", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".bmp": "image/bmp",
    ".ico": "image/x-icon", ".svg": "image/svg+xml", ".avif": "image/avif",
    ".tiff": "image/tiff", ".tif": "image/tiff",
    ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".aac": "audio/aac",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";
  const size = file.size;
  const rangeHeader = c.req.header("Range");

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      const chunk = file.slice(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "max-age=60",
        },
      });
    }
  }

  return new Response(file, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "max-age=60",
    },
  });
});

app.put("/api/file-write", async (c) => {
  const { path: rawPath, content } = await c.req.json<{ path: string; content: string }>();
  if (!rawPath || typeof content !== "string") return c.json({ error: "path and content required" }, 400);
  const { resolve } = await import("path");
  const { writeFile } = await import("fs/promises");
  const target = resolve(rawPath);
  await writeFile(target, content, "utf-8");
  return c.json({ ok: true, path: target });
});

app.post("/api/file-create", async (c) => {
  const { path: rawPath, content } = await c.req.json<{ path: string; content?: string }>();
  if (!rawPath) return c.json({ error: "path required" }, 400);
  const { resolve, dirname } = await import("path");
  const { writeFile, mkdir, stat } = await import("fs/promises");
  const target = resolve(rawPath);
  try { await stat(target); return c.json({ error: "already exists" }, 409); } catch { /* ok */ }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content ?? "", "utf-8");
  return c.json({ ok: true, path: target });
});

app.post("/api/dir-create", async (c) => {
  const { path: rawPath } = await c.req.json<{ path: string }>();
  if (!rawPath) return c.json({ error: "path required" }, 400);
  const { resolve } = await import("path");
  const { mkdir, stat } = await import("fs/promises");
  const target = resolve(rawPath);
  try { await stat(target); return c.json({ error: "already exists" }, 409); } catch { /* ok */ }
  await mkdir(target, { recursive: true });
  return c.json({ ok: true, path: target });
});

// ── Notes ──
// Markdown notes stored in <cwd>/.modus/notes/ with YAML frontmatter.

function notesDir(cwd: string): string {
  return join(cwd, ".modus", "notes");
}

function parseNoteFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  if (!raw.startsWith("---")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { meta: {}, body: raw };
  const frontmatter = raw.slice(4, end).trim();
  const body = raw.slice(end + 4).trim();
  const meta: Record<string, any> = {};
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      try { val = JSON.parse(val); } catch { /* keep as string */ }
    }
    meta[key] = val;
  }
  return { meta, body };
}

function buildNoteFrontmatter(meta: Record<string, any>): string {
  const lines = Object.entries(meta).map(([k, v]) =>
    `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`
  );
  return `---\n${lines.join("\n")}\n---\n\n`;
}

app.get("/api/notes", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const dir = notesDir(cwd);
  const { readdir, readFile } = await import("fs/promises");
  try {
    const files = await readdir(dir);
    const notes = await Promise.all(
      files.filter((f) => f.endsWith(".md")).map(async (f) => {
        const raw = await readFile(join(dir, f), "utf-8");
        const { meta, body } = parseNoteFrontmatter(raw);
        const id = f.replace(/\.md$/, "");
        return {
          id,
          title: meta.title || id,
          created: meta.created || null,
          updated: meta.updated || null,
          tags: meta.tags || [],
          preview: body.slice(0, 120),
        };
      })
    );
    notes.sort((a, b) => (b.updated || b.created || "").localeCompare(a.updated || a.created || ""));
    return c.json(notes);
  } catch (err: any) {
    if (err.code === "ENOENT") return c.json([]);
    return c.json({ error: err.message }, 500);
  }
});

app.get("/api/notes/:id", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const { readFile } = await import("fs/promises");
  const filePath = join(notesDir(cwd), `${c.req.param("id")}.md`);
  try {
    const raw = await readFile(filePath, "utf-8");
    const { meta, body } = parseNoteFrontmatter(raw);
    return c.json({ id: c.req.param("id"), ...meta, content: body });
  } catch (err: any) {
    if (err.code === "ENOENT") return c.json({ error: "not found" }, 404);
    return c.json({ error: err.message }, 500);
  }
});

app.post("/api/notes", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const { mkdir, writeFile } = await import("fs/promises");
  const body = await c.req.json();
  const title = body.title || "untitled";
  const content = body.content || "";
  const tags = body.tags || [];
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 40)}-${Date.now().toString(36)}`;
  const dir = notesDir(cwd);
  await mkdir(dir, { recursive: true });
  const meta = { title, created: now, updated: now, tags };
  const file = buildNoteFrontmatter(meta) + content;
  await writeFile(join(dir, `${id}.md`), file, "utf-8");
  return c.json({ id, title, created: now, updated: now }, 201);
});

app.put("/api/notes/:id", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const { readFile, writeFile } = await import("fs/promises");
  const filePath = join(notesDir(cwd), `${c.req.param("id")}.md`);
  let existing: Record<string, any> = {};
  try {
    const raw = await readFile(filePath, "utf-8");
    existing = parseNoteFrontmatter(raw).meta;
  } catch { /* new note */ }
  const body = await c.req.json();
  const now = new Date().toISOString();
  const meta = {
    title: body.title ?? existing.title ?? "untitled",
    created: existing.created ?? now,
    updated: now,
    tags: body.tags ?? existing.tags ?? [],
  };
  const file = buildNoteFrontmatter(meta) + (body.content ?? "");
  await writeFile(filePath, file, "utf-8");
  return c.json({ id: c.req.param("id"), ...meta });
});

app.delete("/api/notes/:id", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const { unlink } = await import("fs/promises");
  const filePath = join(notesDir(cwd), `${c.req.param("id")}.md`);
  try {
    await unlink(filePath);
    return c.json({ ok: true });
  } catch (err: any) {
    if (err.code === "ENOENT") return c.json({ error: "not found" }, 404);
    return c.json({ error: err.message }, 500);
  }
});

// ── Projects & Init ──

app.get("/api/projects", (c) => {
  const projects = listProjects();
  return c.json(projects.map((p) => ({
    ...p,
    pathExists: existsSync(p.path),
  })));
});

app.get("/api/projects/:id", (c) => {
  const project = getProjectById(c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json(project);
});

app.patch("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  if (typeof body.path !== "string") return c.json({ error: "path required" }, 400);
  const ok = updateProjectPath(id, body.path);
  if (!ok) return c.json({ error: "project not found" }, 404);
  return c.json({ ok: true });
});

app.get("/api/init/status", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(getInitStatus(cwd));
});

app.post("/api/init", async (c) => {
  const body = await c.req.json();
  const cwd = body.cwd;
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const result = initProject(cwd, { name: body.name });
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json(result);
});

// ── Project UI Themes / Fonts ──

app.get("/api/ui/state", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    return c.json(getUiState(cwd));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/themes", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    return c.json(listThemes(cwd));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/themes/:id", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    const theme = getTheme(cwd, c.req.param("id"));
    if (!theme) return c.json({ error: "theme not found" }, 404);
    return c.json(theme);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/theme/active", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    const theme = getActiveTheme(cwd);
    if (!theme) return c.json({ error: "active theme not found" }, 404);
    return c.json(theme);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post("/api/ui/themes/register", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  if (typeof body.themeId !== "string") return c.json({ error: "themeId required" }, 400);
  if (typeof body.cssPath !== "string") return c.json({ error: "cssPath required" }, 400);
  try {
    const theme = registerTheme({
      cwd: body.cwd,
      themeId: body.themeId,
      themeName: typeof body.themeName === "string" ? body.themeName : undefined,
      cssPath: body.cssPath,
      activate: body.activate === true,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      source: typeof body.source === "string" ? body.source : "api",
    });
    return c.json(theme);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post("/api/ui/themes/activate", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  if (typeof body.themeId !== "string") return c.json({ error: "themeId required" }, 400);
  try {
    return c.json(activateTheme(body.cwd, body.themeId));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch("/api/ui/themes/:id", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  try {
    return c.json(patchTheme(body.cwd, c.req.param("id"), {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
    }));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/fonts", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    return c.json(listFonts(cwd));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/fonts/:id", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    const font = getFont(cwd, c.req.param("id"));
    if (!font) return c.json({ error: "font not found" }, 404);
    return c.json(font);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.get("/api/ui/font/active", (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  try {
    const font = getActiveFont(cwd);
    if (!font) return c.json({ error: "active font not found" }, 404);
    return c.json(font);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post("/api/ui/fonts/register", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  if (typeof body.fontId !== "string") return c.json({ error: "fontId required" }, 400);
  if (typeof body.cssPath !== "string") return c.json({ error: "cssPath required" }, 400);
  try {
    const font = registerFont({
      cwd: body.cwd,
      fontId: body.fontId,
      fontName: typeof body.fontName === "string" ? body.fontName : undefined,
      cssPath: body.cssPath,
      activate: body.activate === true,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      source: typeof body.source === "string" ? body.source : "api",
    });
    return c.json(font);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post("/api/ui/fonts/activate", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  if (typeof body.fontId !== "string") return c.json({ error: "fontId required" }, 400);
  try {
    return c.json(activateFont(body.cwd, body.fontId));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch("/api/ui/fonts/:id", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  try {
    return c.json(patchFont(body.cwd, c.req.param("id"), {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
    }));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ── Client Extensions ──

app.get("/api/client-extensions", (c) => {
  const cwd = c.req.query("cwd");
  const userProfile = c.req.query("userProfile");
  const token = new URL(c.req.url).searchParams.get("token");
  const query = new URLSearchParams();
  if (cwd) query.set("cwd", cwd);
  if (userProfile) query.set("userProfile", userProfile);
  if (token) query.set("token", token);

  const suffix = query.toString();
  const moduleQuery = suffix ? `?${suffix}` : "";
  const config = getResolvedClientExtensionsConfig(cwd, userProfile);
  return c.json(
    listClientExtensions({ cwd, userProfile }).map((extension) => ({
      id: extension.id,
      fileName: extension.fileName,
      source: extension.source,
      enabled: extension.enabled,
      moduleUrl: `/api/client-extensions/${encodeURIComponent(extension.id)}/module${moduleQuery}`,
      meta: extension.meta,
      settingsValues: resolveExtensionSettings(extension.meta.settings, config.settings?.[extension.id]),
    })),
  );
});

app.get("/api/client-extensions/:id/module", async (c) => {
  const cwd = c.req.query("cwd");
  const userProfile = c.req.query("userProfile");
  const extension = getClientExtensionById(c.req.param("id"), { cwd, userProfile });
  if (!extension) return c.json({ error: "extension not found" }, 404);
  const file = Bun.file(extension.absolutePath);
  if (!(await file.exists())) return c.json({ error: "extension file not found" }, 404);
  return new Response(file, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
});

app.patch("/api/client-extensions/:id", async (c) => {
  const userProfileName = c.req.query("userProfile");
  if (!userProfileName) return c.json({ error: "userProfile query param required" }, 400);
  const profile = getUserProfileConfig(userProfileName);
  if (!profile) return c.json({ error: "user profile not found" }, 404);

  const id = c.req.param("id");
  const body = await c.req.json() as { enabled?: boolean; settings?: Record<string, unknown> };
  const ext = getUserProfileUiConfig(userProfileName)?.clientExtensions ?? profile.clientExtensions ?? {};

  if (typeof body.enabled === "boolean") {
    const enabledSet = new Set(ext.enabled ?? []);
    const disabledSet = new Set(ext.disabled ?? []);
    if (body.enabled) {
      enabledSet.add(id);
      disabledSet.delete(id);
    } else {
      disabledSet.add(id);
      enabledSet.delete(id);
    }
    ext.enabled = enabledSet.size > 0 ? Array.from(enabledSet) : undefined;
    ext.disabled = disabledSet.size > 0 ? Array.from(disabledSet) : undefined;
  }

  if (body.settings) {
    ext.settings = { ...(ext.settings ?? {}), [id]: { ...(ext.settings?.[id] ?? {}), ...body.settings } };
  }

  patchUserProfileUiConfig(userProfileName, { clientExtensions: ext });
  return c.json({ ok: true });
});

app.post("/api/whisper/transcribe", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
    console.log("[whisper/transcribe] received", {
      name: file.name,
      size: file.size,
      type: file.type,
    });

    const whisperBody = new FormData();
    whisperBody.set("file", file, file.name);
    whisperBody.set("response_format", "verbose_json");

    const upstream = await fetch(WHISPER_TRANSCRIBE_URL, {
      method: "POST",
      body: whisperBody,
    });
    const upstreamText = await upstream.text();
    console.log("[whisper/transcribe] upstream", {
      ok: upstream.ok,
      status: upstream.status,
      body: upstreamText,
    });
    if (!upstream.ok) {
      return c.json({ error: "whisper transcription failed", details: upstreamText.trim() }, 502);
    }

    const parsed = upstreamText ? JSON.parse(upstreamText) : {};

    // Filter segments by no_speech_prob to suppress noise hallucinations.
    // Whisper's verbose_json includes per-segment confidence — segments with
    // high no_speech_prob are silence/noise that Whisper invented text for.
    const NO_SPEECH_THRESHOLD = 0.6;
    let text: string;
    if (Array.isArray(parsed?.segments) && parsed.segments.length > 0) {
      text = parsed.segments
        .filter((seg: any) => (seg.no_speech_prob ?? 0) < NO_SPEECH_THRESHOLD)
        .map((seg: any) => seg.text)
        .join("")
        .trim();
    } else {
      text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
    }

    return c.json({ text });
  } catch (err: any) {
    console.error("[whisper/transcribe]", err);
    return c.json({ error: err?.message ?? "whisper transcription failed" }, 502);
  }
});

// ── Memories (reads from agent_memory store) ──

const MEMORY_BASE = Bun.fileURLToPath(new URL("../agent_memory/memory", import.meta.url));

async function readMemoriesFromDir(dir: string): Promise<any[]> {
  const { readdir, readFile } = await import("fs/promises");
  const { resolve } = await import("path");
  const memories: any[] = [];
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const text = await readFile(resolve(dir, f), "utf-8");
    const meta: Record<string, any> = {};
    let body = text;
    if (text.startsWith("---")) {
      const end = text.indexOf("---", 3);
      if (end !== -1) {
        for (const line of text.slice(3, end).trim().split("\n")) {
          const sep = line.indexOf(":");
          if (sep === -1) continue;
          const key = line.slice(0, sep).trim();
          let val: any = line.slice(sep + 1).trim().replace(/^["']|["']$/g, "");
          if (val.startsWith("[") && val.endsWith("]")) {
            val = val.slice(1, -1).split(",").map((v: string) => v.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
          }
          meta[key] = val;
        }
        body = text.slice(end + 3).trim();
      }
    }
    memories.push({
      id: f.replace(/\.md$/, ""),
      type: meta.type ?? "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      confidence: meta.confidence ?? "",
      created: meta.created ?? "",
      profile: meta.profile ?? null,
      user_profile: meta.user_profile ?? null,
      priority: parseInt(meta.priority ?? "0", 10) || 0,
      body,
    });
  }
  return memories;
}

app.get("/api/memories", async (c) => {
  try {
    const profileName = new URL(c.req.url).searchParams.get("userProfile");
    const cwd = new URL(c.req.url).searchParams.get("cwd");
    const userProf = profileName ? getUserProfile(profileName) : undefined;

    // Read from project-local .modus/memory/ when CWD is provided, with global fallback
    let allMems: any[];
    if (cwd) {
      const projectMemDir = join(cwd, ".modus", "memory");
      const [projectMems, globalMems] = await Promise.all([
        readMemoriesFromDir(projectMemDir),
        readMemoriesFromDir(MEMORY_BASE),
      ]);
      // Project memories override global by ID
      const byId = new Map(globalMems.map(m => [m.id, m]));
      for (const m of projectMems) byId.set(m.id, m);
      allMems = [...byId.values()];
    } else {
      allMems = await readMemoriesFromDir(MEMORY_BASE);
    }

    if (profileName) {
      const allowedAgents = userProf?.agentProfiles?.length ? new Set(userProf.agentProfiles) : null;
      return c.json(allMems.filter(m => {
        // Match by user_profile stamp if present
        if (m.user_profile) return m.user_profile === profileName;
        // Match by agent profile if user profile has a scoped agent list
        if (allowedAgents && m.profile) return allowedAgents.has(m.profile);
        // Untagged memories are global — include them
        return !m.profile;
      }));
    }

    return c.json(allMems);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Actions ──

import {
  initActions, stopActions, getActions, getActionState,
  triggerAction, handleWebhook, updateActionConfig,
  resetAction, setActionPreference, getActionPreferences,
  reloadActions, cancelExecution, startNewExecution,
  addActionTag, removeActionTag,
} from "./action-runner";
import { getActionRuns as dbGetActionRuns, clearActionRuns, getExecutions, getRunsByExecution } from "./db";

app.get("/api/actions", (c) => {
  const userProfileName = new URL(c.req.url).searchParams.get("userProfile");
  let actions = getActions();
  if (userProfileName) {
    const userProf = getUserProfile(userProfileName);
    if (userProf?.actions && !userProf.actions.includes("*")) {
      actions = actions.filter(a => userProf.actions!.includes(a.name));
    }
  }
  return c.json(actions);
});

app.get("/api/actions/:name", (c) => {
  const name = c.req.param("name");
  const state = getActionState(name);
  if (!state) return c.json({ error: "action not found" }, 404);
  // Derive flat fields from active execution for API compat
  const exec = Array.from(state.activeExecutions.values()).find(e => e.status === "running");
  return c.json({
    ...state.config,
    nextRunAt: state.nextRunAt,
    lastRunAt: state.lastRunAt,
    lastStatus: exec?.lastStatus ?? null,
    running: state.activeExecutions.size > 0,
  });
});

app.get("/api/actions/:name/runs", (c) => {
  const name = c.req.param("name");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(dbGetActionRuns(name, limit));
});

// ── Execution endpoints ──

app.get("/api/actions/:name/executions", (c) => {
  const name = c.req.param("name");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(getExecutions(name, limit));
});

app.get("/api/actions/:name/executions/:execId/runs", (c) => {
  const execId = Number(c.req.param("execId"));
  if (isNaN(execId)) return c.json({ error: "invalid execution id" }, 400);
  return c.json(getRunsByExecution(execId));
});

app.post("/api/actions/:name/executions", (c) => {
  const name = c.req.param("name");
  const result = startNewExecution(name);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, executionId: result.executionId });
});

app.delete("/api/actions/:name/executions/:execId", (c) => {
  const name = c.req.param("name");
  const execId = Number(c.req.param("execId"));
  if (isNaN(execId)) return c.json({ error: "invalid execution id" }, 400);
  const ok = cancelExecution(name, execId);
  if (!ok) return c.json({ error: "execution not found or not active" }, 404);
  return c.json({ ok: true });
});

app.post("/api/actions/:name/trigger", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const ok = await triggerAction(name, { userProfile: body.userProfile });
  if (!ok) return c.json({ error: "action not found or already running" }, 400);
  return c.json({ ok: true });
});

app.post("/api/actions/:name/hook", async (c) => {
  const name = c.req.param("name");
  const token = new URL(c.req.url).searchParams.get("token") ?? "";
  const payload = await c.req.json().catch(() => ({}));
  const result = await handleWebhook(name, token, payload);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, ...(result.sessionId ? { sessionId: result.sessionId } : {}), ...(result.continued ? { continued: true } : {}) });
});

app.get("/api/actions/:name/info", async (c) => {
  const name = c.req.param("name");
  const state = getActionState(name);
  if (!state) return c.json({ error: "action not found" }, 404);
  const actDir = state.actionDir;
  let contextSource = "";
  let configSource = "";
  try { contextSource = await Bun.file(join(actDir, "context.ts")).text(); } catch { /* missing */ }
  try { configSource = await Bun.file(join(actDir, "action.json")).text(); } catch { /* missing */ }
  return c.json({ contextSource, configSource });
});

app.delete("/api/actions/:name/runs", (c) => {
  const name = c.req.param("name");
  const state = getActionState(name);
  if (!state) return c.json({ error: "action not found" }, 404);
  clearActionRuns(name);
  return c.json({ ok: true });
});

app.post("/api/actions/:name/reset", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const ok = resetAction(name);
  if (!ok) return c.json({ error: "action not found or running" }, 400);
  if (body.skipConfirm) {
    setActionPreference(name, "skipResetConfirm", true);
  }
  return c.json({ ok: true });
});

app.get("/api/actions/:name/preferences", (c) => {
  const name = c.req.param("name");
  return c.json(getActionPreferences(name));
});

app.post("/api/actions/:name/tags", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const tag = body.tag;
  if (!tag || typeof tag !== "string") return c.json({ error: "tag required" }, 400);
  const ok = addActionTag(name, tag.toLowerCase().trim());
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/actions/:name/tags/:tag", (c) => {
  const name = c.req.param("name");
  const tag = c.req.param("tag");
  const ok = removeActionTag(name, tag);
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.patch("/api/actions/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const ok = updateActionConfig(name, body);
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/actions/reload", (c) => {
  reloadActions();
  const actions = getActions();
  return c.json({ ok: true, count: actions.length });
});

// ── Prompts ──

import { loadPrompts, listPrompts, renderPrompt, reloadPrompts } from "./prompt-loader";

app.get("/api/prompts", (c) => {
  const params = new URL(c.req.url).searchParams;
  const tags = params.get("tags")?.split(",").filter(Boolean);
  const projectCwd = params.get("projectCwd") ?? undefined;
  return c.json(listPrompts({ tags, projectCwd }));
});

app.post("/api/prompts/:name/render", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const projectCwd = body.projectCwd ?? undefined;
  const vars = { ...body, projectCwd: undefined };
  const result = await renderPrompt(name, vars, projectCwd);
  if ("error" in result) return c.json(result, 404);
  return c.json(result);
});

app.post("/api/prompts/reload", (c) => {
  reloadPrompts();
  const prompts = listPrompts();
  return c.json({ ok: true, count: prompts.length, names: prompts.map(p => p.name) });
});

// ── Git ──

import { gitStatus, gitLog, gitShow, gitFileDiff, gitReadme, gitFileContent } from "./git";

app.get("/api/git/status", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(await gitStatus(cwd));
});

app.get("/api/git/log", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const limit = Number(params.get("limit") ?? 30);
  return c.json(await gitLog(cwd, limit));
});

app.get("/api/git/show/:hash", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const hash = c.req.param("hash");
  const detail = await gitShow(cwd, hash);
  if (!detail) return c.json({ error: "commit not found" }, 404);
  return c.json(detail);
});

app.get("/api/git/readme", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const readme = await gitReadme(cwd);
  if (!readme) return c.json(null);
  return c.json(readme);
});

app.get("/api/git/file-content", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd");
  const hash = params.get("hash");
  const path = params.get("path");
  if (!cwd || !hash || !path) return c.json({ error: "cwd, hash, and path required" }, 400);
  const content = await gitFileContent(cwd, hash, path);
  if (content === null) return c.json({ error: "file not found" }, 404);
  return c.json({ content });
});

/** Serve raw files from a repo working tree (for images, etc.) */
app.get("/api/git/raw/*", async (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const filePath = c.req.path.replace("/api/git/raw/", "");
  if (!filePath || filePath.includes("..")) return c.json({ error: "invalid path" }, 400);
  const fullPath = resolve(cwd, filePath);
  if (!fullPath.startsWith(resolve(cwd))) return c.json({ error: "path traversal" }, 403);
  const file = Bun.file(fullPath);
  if (!(await file.exists())) return c.json({ error: "not found" }, 404);
  return new Response(file.stream(), {
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
});

app.get("/api/git/file-diff", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd");
  const file = params.get("file");
  if (!cwd || !file) return c.json({ error: "cwd and file required" }, 400);
  return c.json(await gitFileDiff(cwd, file));
});

// ── Open in Editor ──

app.post("/api/open-in-editor", async (c) => {
  const body = await c.req.json<{ filePath: string; line?: number; editor?: string }>();
  if (!body.filePath) return c.json({ error: "filePath required" }, 400);
  const target = body.line ? `${body.filePath}:${body.line}` : body.filePath;
  try {
    const editor = body.editor ?? (Bun.which("cursor") ? "cursor" : "code");
    Bun.spawn([editor, "--goto", target], { stdout: "ignore", stderr: "ignore" });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── Serve raw file (for browser preview) ──

const MIME_MAP: Record<string, string> = {
  ".html": "text/html", ".htm": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp",
  ".css": "text/css", ".js": "text/javascript",
  ".json": "application/json", ".xml": "application/xml",
  ".pdf": "application/pdf", ".md": "text/markdown",
  ".txt": "text/plain",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogg": "video/ogg",
};

app.get("/api/file/raw", async (c) => {
  const filePath = new URL(c.req.url).searchParams.get("path");
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = resolve(filePath);
  const file = Bun.file(abs);
  if (!(await file.exists())) return c.json({ error: "not found" }, 404);

  const ext = extname(abs).toLowerCase();
  const mime = MIME_MAP[ext] ?? "text/plain";
  return new Response(file, { headers: { "Content-Type": mime } });
});

// ── Resource Observability ──

function getResourceSnapshot() {
  const mem = process.memoryUsage();
  const sessions = getAllActiveSessions();
  const terminals = getAllActiveTerminals();
  let totalSubscribers = 0;
  const sessionsByStatus: Record<string, number> = {};
  for (const s of sessions) {
    sessionsByStatus[s.status] = (sessionsByStatus[s.status] ?? 0) + 1;
    totalSubscribers += s.subscribers.size;
  }
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
      arrayBuffersMB: Math.round(mem.arrayBuffers / 1024 / 1024),
    },
    sessions: {
      active: sessions.length,
      byStatus: sessionsByStatus,
    },
    terminals: {
      active: terminals.length,
    },
    sseSubscribers: totalSubscribers,
    timestamp: Date.now(),
  };
}

app.get("/api/stats/resources", (c) => {
  return c.json(getResourceSnapshot());
});

// Log resource snapshot every 5 minutes to activity.db for trend analysis
const RESOURCE_LOG_INTERVAL_MS = 5 * 60 * 1000;
const resourceLogTimer = setInterval(() => {
  const snap = getResourceSnapshot();
  logActivity({
    eventType: "resource_snapshot",
    summary: `heap=${snap.memory.heapUsedMB}MB rss=${snap.memory.rssMB}MB sessions=${snap.sessions.active} terminals=${snap.terminals.active} subs=${snap.sseSubscribers}`,
    metadata: snap,
  });
}, RESOURCE_LOG_INTERVAL_MS);
// Don't block process exit
if (resourceLogTimer.unref) resourceLogTimer.unref();

// ── Storage Stats & Compaction ──

app.get("/api/stats/storage", (c) => {
  return c.json(storageStats());
});

app.get("/api/stats/sessions", (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;
  return c.json(getSessionStats(userProfile));
});

app.get("/api/analytics/provider-usage", (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;
  const days = params.get("days") ? Number(params.get("days")) : undefined;
  return c.json(getProviderUsageAnalytics({ userProfile, days }));
});

app.get("/api/analytics/deep", (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;
  const cwd = params.get("cwd") ?? undefined;
  const provider = params.get("provider") ?? undefined;
  const start = params.get("start") ? Number(params.get("start")) : undefined;
  const end = params.get("end") ? Number(params.get("end")) : undefined;
  const bucketMs = params.get("bucketMs") ? Number(params.get("bucketMs")) : undefined;

  const analytics = getDeepAnalytics({ userProfile, cwd, provider, start, end, bucketMs });
  const touches = queryTouches(traceDb, {
    userProfile,
    cwd,
    from: analytics.range.start,
    to: analytics.range.end,
  });
  const summary = touchSummary(touches);
  const sessionTouchCount = new Map<string, number>();
  const fileAgg = new Map<string, {
    filePath: string;
    fileKind: "code" | "docs";
    touches: number;
    sessions: Set<string>;
    lastTouched: number;
    provider: string | null;
  }>();

  for (const touch of touches) {
    sessionTouchCount.set(touch.sessionId, (sessionTouchCount.get(touch.sessionId) ?? 0) + 1);

    const idx = Math.floor((touch.timestamp - analytics.range.start) / analytics.range.bucketMs);
    if (idx >= 0 && idx < analytics.buckets.length) analytics.buckets[idx].touches += 1;

    const existing = fileAgg.get(touch.filePath);
    if (existing) {
      existing.touches += 1;
      existing.sessions.add(touch.sessionId);
      if (touch.timestamp > existing.lastTouched) existing.lastTouched = touch.timestamp;
    } else {
      fileAgg.set(touch.filePath, {
        filePath: touch.filePath,
        fileKind: touch.fileKind,
        touches: 1,
        sessions: new Set([touch.sessionId]),
        lastTouched: touch.timestamp,
        provider: touch.provider,
      });
    }
  }

  const sessions = analytics.sessions.map((session) => ({
    ...session,
    touches: sessionTouchCount.get(session.id) ?? 0,
  }));

  return c.json({
    ...analytics,
    sessions,
    trace: {
      summary,
      topFiles: [...fileAgg.values()]
        .map((row) => ({
          filePath: row.filePath,
          fileKind: row.fileKind,
          touches: row.touches,
          sessions: row.sessions.size,
          lastTouched: row.lastTouched,
          provider: row.provider,
        }))
        .sort((a, b) => b.touches - a.touches || b.lastTouched - a.lastTouched)
        .slice(0, 20),
    },
  });
});

app.get("/api/account", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;

  // Get Claude Code auth status
  let account: Record<string, unknown> | null = null;
  try {
    const proc = Bun.spawn(
      [process.platform === "win32" ? "claude.cmd" : "claude", "auth", "status", "--json"],
      { env: { ...process.env, CLAUDECODE: "" }, stdout: "pipe", stderr: "pipe" },
    );
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (text.trim()) account = JSON.parse(text.trim());
  } catch { /* silent — account info is optional */ }

  // Get period-based cost summaries from local DB
  const costs = getPeriodCosts(userProfile);

  return c.json({ account, costs });
});

app.get("/api/gemini/usage", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd") ?? process.cwd();
  return c.json(await fetchGeminiUsageSnapshot({ cwd }));
});

app.post("/api/prune", (c) => {
  const result = pruneAllSessionEvents();
  return c.json(result);
});

app.post("/api/prune/:sessionId", (c) => {
  const result = pruneSessionEvents(c.req.param("sessionId"));
  return c.json(result);
});

// ── Activity Log ──

app.get("/api/activity", (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;
  const since = params.get("since") ? Number(params.get("since")) : undefined;
  const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
  const eventType = params.get("eventType") ?? undefined;
  return c.json(getActivityLog({ userProfile, since, limit, eventType }));
});

app.get("/api/activity/summary", (c) => {
  const params = new URL(c.req.url).searchParams;
  const userProfile = params.get("userProfile") ?? undefined;
  const hours = params.get("hours") ? Number(params.get("hours")) : undefined;
  return c.json(getActivitySummary({ userProfile, hours }));
});

// ── Moves ──

import { listMoves, getMove, activateMove, attachMove, activateAttachedMove, detachMove, getMoveRuns, getToken, getActiveTokensForSession, handleMoveApiSubmit, resolveMoveLocation, getActiveWidgetForSession, rekeyMoveRegistrySession, rekeyMoveByToken, deactivateAmbientMove, getActiveAmbientMoves } from "./move-runner";
import { getMoveRunsBySession, getMoveRunById, getRecentMoveRuns } from "./move-db";
import { handleModusMcpRequest } from "./modus-mcp";

// List available moves for a CWD
app.get("/api/moves", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(listMoves(cwd));
});

// Get a specific move definition
app.get("/api/moves/:name", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const move = getMove(c.req.param("name"), cwd);
  if (!move) return c.json({ error: "move not found" }, 404);
  return c.json(move);
});

// Activate a move without a parent session
app.post("/api/moves/activate", async (c) => {
  const body = await c.req.json();
  const { moveName, inputs, cwd, userProfile, modeOverride, forceNewSession } = body;
  if (!moveName) return c.json({ error: "moveName required" }, 400);
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const move = getMove(moveName, cwd);
  if (!move) return c.json({ error: "move not found" }, 404);

  const result = await activateMove({
    moveName,
    inputs: inputs ?? {},
    cwd,
    userProfile,
    modeOverride,
    forceNewSession,
  });

  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// Get move run history
app.get("/api/moves/:name/runs", (c) => {
  const name = c.req.param("name");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(getMoveRuns(name, limit));
});

// Get recent move runs across all sessions
app.get("/api/move-runs/recent", (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 50);
  return c.json(getRecentMoveRuns(limit));
});

// Get a specific move run by ID
app.get("/api/move-runs/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const run = getMoveRunById(id);
  if (!run) return c.json({ error: "move run not found" }, 404);
  return c.json(run);
});

// Get move runs for a session
app.get("/api/sessions/:id/moves", (c) => {
  const sessionId = c.req.param("id");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(getMoveRunsBySession(sessionId, limit));
});

// Get active move tokens for a session
app.get("/api/sessions/:id/moves/active", (c) => {
  const sessionId = c.req.param("id");
  const tokens = getActiveTokensForSession(sessionId);
  return c.json(tokens.map(t => ({
    token: t.token,
    moveName: t.moveName,
    mode: t.mode,
    status: t.status,
    createdAt: t.createdAt,
    attempts: t.attempts,
    spawnedSessionId: t.spawnedSessionId,
  })));
});

// Get all active move widgets for a session (for restoring on refresh)
app.get("/api/sessions/:id/moves/widget", (c) => {
  const sessionId = c.req.param("id");
  return c.json(getActiveWidgetForSession(sessionId));
});

// Rekey move registry entries when a session ID changes (empty session → real session)
app.post("/api/sessions/:id/moves/rekey", async (c) => {
  const oldId = c.req.param("id");
  const { newSessionId } = await c.req.json();
  if (!newSessionId) return c.json({ error: "newSessionId required" }, 400);
  console.log(`[move-reg] rekey endpoint called: ${oldId} → ${newSessionId}`);
  rekeyMoveRegistrySession(oldId, newSessionId);
  return c.json({ ok: true });
});

app.post("/api/moves/rekey-by-token", async (c) => {
  const { apiToken, newSessionId } = await c.req.json();
  if (!apiToken || !newSessionId) return c.json({ error: "apiToken and newSessionId required" }, 400);
  const ok = rekeyMoveByToken(apiToken, newSessionId);
  return c.json({ ok });
});

// Activate a move on a session
app.post("/api/sessions/:id/moves/activate", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json();
  const { moveName, inputs, cwd, userProfile, modeOverride, forceNewSession } = body;
  if (!moveName) return c.json({ error: "moveName required" }, 400);
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const result = await activateMove({
    moveName,
    sessionId,
    inputs: inputs ?? {},
    cwd,
    userProfile,
    modeOverride,
    forceNewSession,
  });

  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// List active ambient (persistent) moves for a session
app.get("/api/sessions/:id/moves/ambient", (c) => {
  const sessionId = c.req.param("id");
  const moves = getActiveAmbientMoves(sessionId);
  return c.json(moves.map(m => ({
    moveName: m.moveName,
    activatedAt: m.activatedAt,
    inputs: m.inputs,
  })));
});

// Deactivate an ambient (persistent) move
app.post("/api/sessions/:id/moves/deactivate", async (c) => {
  const sessionId = c.req.param("id");
  const { moveName } = await c.req.json();
  if (!moveName) return c.json({ error: "moveName required" }, 400);
  const removed = deactivateAmbientMove(sessionId, moveName);
  if (!removed) return c.json({ error: "Ambient move not found on this session" }, 404);
  return c.json({ ok: true, moveName });
});

// ── Widget-First Activation (attach/activate-attached) ──

// Attach a move (phase 1): create API registration + widget, no gather/message
app.post("/api/moves/:name/attach", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const { inputs, cwd, userProfile, sessionId } = body;
  console.log(`[attach] name=${name} cwd=${cwd} sessionId=${sessionId} userProfile=${userProfile}`);
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const result = await attachMove({
    moveName: name,
    sessionId,
    inputs: inputs ?? {},
    cwd,
    userProfile,
  });

  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// Activate an attached move (phase 2): run gather + send message
app.post("/api/moves/:name/activate-attached", async (c) => {
  const body = await c.req.json();
  const { apiToken, text, userProfile } = body;
  if (typeof apiToken !== "string") return c.json({ error: "apiToken required" }, 400);

  const result = await activateAttachedMove({ apiToken, text, userProfile });
  return c.json(result, result.ok ? 200 : 400);
});

// Detach a move (cleanup): remove API registration without activating
app.post("/api/moves/:name/detach", async (c) => {
  const body = await c.req.json();
  const { apiToken } = body;
  if (typeof apiToken !== "string") return c.json({ error: "apiToken required" }, 400);

  const removed = detachMove(apiToken);
  if (!removed) return c.json({ error: "Move not found or already detached" }, 404);
  return c.json({ ok: true });
});

// ── Move Widget Serving ──

// Serve a move's widget component (on-the-fly transpile)
const widgetCache = new Map<string, { mtime: number; js: string }>();

app.get("/api/moves/:name/widget", async (c) => {
  const name = c.req.param("name");
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const move = getMove(name, cwd);
  if (!move?.widget?.component) return c.json({ error: "move has no widget" }, 404);

  const location = resolveMoveLocation(name, cwd);
  if (!location) return c.json({ error: "move not found" }, 404);

  const srcPath = join(location.dir, move.widget.component);
  try {
    const { statSync } = await import("fs");
    const mtime = statSync(srcPath).mtimeMs;

    const cached = widgetCache.get(srcPath);
    if (cached && cached.mtime === mtime) {
      return new Response(cached.js, { headers: { "Content-Type": "application/javascript" } });
    }

    const result = await Bun.build({
      entrypoints: [srcPath],
      format: "esm",
      target: "browser",
      external: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
      // Force production JSX (jsx/jsxs from jsx-runtime, not jsxDEV from jsx-dev-runtime)
      // so widgets work in both dev and production React environments
      define: { "process.env.NODE_ENV": '"production"' },
    });

    if (!result.success) {
      console.error(`[widget] Build failed for ${srcPath}:`, result.logs);
      return c.json({ error: "widget build failed" }, 500);
    }

    const js = await result.outputs[0].text();
    widgetCache.set(srcPath, { mtime, js });
    return new Response(js, { headers: { "Content-Type": "application/javascript" } });
  } catch (err) {
    return c.json({ error: `widget load failed: ${err}` }, 500);
  }
});

// Serve a move's widget CSS (optional — auto-loaded by MoveWidget if it exists)
app.get("/api/moves/:name/widget.css", async (c) => {
  const name = c.req.param("name");
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const location = resolveMoveLocation(name, cwd);
  if (!location) return new Response("", { status: 404 });

  const cssPath = join(location.dir, "widget.css");
  try {
    const { readFileSync } = await import("fs");
    const css = readFileSync(cssPath, "utf-8");
    return new Response(css, { headers: { "Content-Type": "text/css" } });
  } catch {
    return new Response("", { status: 404 });
  }
});

// Call a move API op from the frontend (caller: "user")
app.post("/api/moves/:name/op", async (c) => {
  const body = await c.req.json();
  const { apiToken, op, ...rest } = body;
  if (typeof apiToken !== "string") return c.json({ error: "apiToken required" }, 400);
  if (typeof op !== "string") return c.json({ error: "op required" }, 400);

  const result = await handleMoveApiSubmit(apiToken, { op, ...rest }, "user");
  return c.json(result, result.ok ? 200 : 400);
});

// Modus MCP endpoint — Streamable HTTP transport for modus_submit
app.all("/api/mcp/modus", async (c) => {
  return handleModusMcpRequest(c.req.raw);
});
app.all("/api/mcp/modus/*", async (c) => {
  return handleModusMcpRequest(c.req.raw);
});

// ── Missions ──

import {
  listMissions, getMission, startMission,
  getMissionRunSummary, listMissionRunSummaries,
  listMissionStepSummaries, listMissionAssignmentSummaries,
  listMissionTransferSummaries, listMissionGateResultSummaries,
  listMissionSessionIds,
  pauseMissionRun, resumeMissionRun,
} from "./mission-runner";

// List mission definitions
app.get("/api/missions", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(listMissions(cwd));
});

// Start a mission run
app.post("/api/missions/start", async (c) => {
  const body = await c.req.json();
  const { missionName, userProfile } = body;
  let { cwd } = body;
  if (!missionName) return c.json({ error: "missionName required" }, 400);
  // Resolve cwd from user profile if not explicitly provided
  if (!cwd && userProfile) {
    const up = getUserProfile(userProfile);
    cwd = up?.projects?.[0];
  }
  if (!cwd) return c.json({ error: "cwd required — provide cwd or a userProfile with a project path" }, 400);
  const result = await startMission({ missionName, cwd, userProfile });
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

// List mission runs
app.get("/api/missions/runs", (c) => {
  const q = new URL(c.req.url).searchParams;
  return c.json(listMissionRunSummaries({
    cwd: q.get("cwd") ?? undefined,
    status: q.get("status") ?? undefined,
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
  }));
});

// Get a specific mission run
app.get("/api/missions/runs/:id", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const run = getMissionRunSummary(id);
  if (!run) return c.json({ error: "run not found" }, 404);
  return c.json(run);
});

// Get steps for a run
app.get("/api/missions/runs/:id/steps", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMissionStepSummaries(id));
});

// Get assignments for a run
app.get("/api/missions/runs/:id/assignments", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMissionAssignmentSummaries(id));
});

// Get transfers for a run
app.get("/api/missions/runs/:id/transfers", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMissionTransferSummaries(id));
});

// Get gate results for a run
app.get("/api/missions/runs/:id/gates", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMissionGateResultSummaries(id));
});

// Get sessions for a run
app.get("/api/missions/runs/:id/sessions", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  return c.json(listMissionSessionIds(id));
});

// Get a specific mission definition
app.get("/api/missions/:name", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const mission = getMission(c.req.param("name"), cwd);
  if (!mission) return c.json({ error: "mission not found" }, 404);
  return c.json(mission);
});

// Pause a run
app.post("/api/missions/runs/:id/pause", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const body = await c.req.json();
  const result = pauseMissionRun(id, body.reason ?? "Paused via API");
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

// Resume a run
app.post("/api/missions/runs/:id/resume", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const result = resumeMissionRun(id);
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

// ── Trace (Attention Trace View) ──

import { queryTouches, touchSummary } from "./trace";
import { default as traceDb } from "./trace-db";

app.get("/api/trace/touches", (c) => {
  const q = c.req.query();
  const touches = queryTouches(traceDb, {
    limit: q.limit ? parseInt(q.limit, 10) : undefined,
    userProfile: q.userProfile || undefined,
    cwd: q.cwd || undefined,
    from: q.from ? parseInt(q.from, 10) : undefined,
    to: q.to ? parseInt(q.to, 10) : undefined,
    ops: q.ops ? q.ops.split(",") : undefined,
    confidence: q.confidence ? q.confidence.split(",") : undefined,
    sessionId: q.sessionId || undefined,
  });
  return c.json({ touches, summary: touchSummary(touches) });
});

// ── Web Positions (spatial layout for session web view) ──

app.get("/api/web/positions", (c) => {
  const scope = c.req.query("scope");
  if (!scope) return c.json({ error: "scope is required" }, 400);
  return c.json(getWebPositions(scope));
});

app.patch("/api/web/positions", async (c) => {
  const body = await c.req.json();
  const { scope, positions } = body;
  if (!scope || !Array.isArray(positions)) {
    return c.json({ error: "scope and positions[] are required" }, 400);
  }
  upsertWebPositions(scope, positions);
  return c.json({ ok: true, count: positions.length });
});

app.delete("/api/web/positions", (c) => {
  const scope = c.req.query("scope");
  if (!scope) return c.json({ error: "scope is required" }, 400);
  deleteWebPositions(scope);
  return c.json({ ok: true });
});

function normalizeUiPath(pathname: string): string {
  return pathname.split("/").filter((segment) => segment && segment !== "." && segment !== "..").join("/");
}

async function serveUiFile(pathname: string): Promise<Response | null> {
  const relativePath = normalizeUiPath(pathname);
  const targetPath = join(UI_DIST_DIR, relativePath || "index.html");
  const file = Bun.file(targetPath);
  if (!(await file.exists())) return null;
  const cacheControl = relativePath.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  return new Response(file, {
    headers: {
      "Cache-Control": cacheControl,
    },
  });
}

function missingUiBuildResponse(): Response {
  return new Response("frontend build missing: run the UI build before using the harness app surface", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ── Terminals ──

app.post("/api/terminals", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const term = createTerminal({
      shell: body.shell,
      cwd: body.cwd,
      cols: body.cols,
      rows: body.rows,
      sessionId: body.sessionId,
      env: body.env,
    });
    return c.json({
      id: term.id,
      shell: term.shell,
      cwd: term.cwd,
      cols: term.cols,
      rows: term.rows,
      sessionId: term.sessionId,
      createdAt: term.createdAt,
    });
  } catch (err) {
    console.error("Failed to create terminal:", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/api/terminals", (c) => {
  const filterSessionId = c.req.query("sessionId") ?? null;
  const active = getAllActiveTerminals()
    .filter(t => !filterSessionId || t.sessionId === filterSessionId)
    .map(t => ({
      id: t.id,
      shell: t.shell,
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      sessionId: t.sessionId,
      createdAt: t.createdAt,
      clients: t.clients.size,
    }));
  return c.json(active);
});

app.get("/api/terminals/:id", (c) => {
  const id = c.req.param("id");
  const active = getActiveTerminal(id);
  if (active) {
    return c.json({
      id: active.id,
      shell: active.shell,
      cwd: active.cwd,
      cols: active.cols,
      rows: active.rows,
      sessionId: active.sessionId,
      createdAt: active.createdAt,
      clients: active.clients.size,
      status: "running",
    });
  }
  const row = getTerminalInfo(id);
  if (row) return c.json(row);
  return c.json({ error: "terminal not found" }, 404);
});

app.delete("/api/terminals/:id", (c) => {
  const id = c.req.param("id");
  const killed = killTerminal(id);
  if (!killed) return c.json({ error: "terminal not found or already exited" }, 404);
  return c.json({ ok: true });
});

app.post("/api/terminals/:id/resize", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const { cols, rows } = body;
  if (typeof cols !== "number" || typeof rows !== "number") {
    return c.json({ error: "cols and rows required" }, 400);
  }
  const ok = resizeTerminalPty(id, cols, rows);
  if (!ok) return c.json({ error: "terminal not found" }, 404);
  return c.json({ ok: true, cols, rows });
});

app.get("*", async (c) => {
  const path = c.req.path;
  if (path === "/api" || path.startsWith("/api/")) return c.notFound();
  if (!existsSync(UI_INDEX_PATH)) return missingUiBuildResponse();

  const direct = await serveUiFile(path);
  if (direct) return direct;

  if (extname(path)) return c.notFound();

  return (await serveUiFile("/")) ?? missingUiBuildResponse();
});

// ── Start ──

// Wire terminal auth checker (reuses same PIN + token auth as REST)
setAuthChecker((token: string) => {
  if (!AUTH_TOKEN && !getPin()) return true;  // no auth configured
  if (AUTH_TOKEN && token === AUTH_TOKEN) return true;
  if (pinSessions.has(token)) return true;
  return false;
});

const server = Bun.serve({
  fetch(req, server) {
    // Intercept WebSocket upgrade requests before Hono
    const wsResult = tryUpgradeTerminalWS(req, server);
    if (wsResult !== null) return wsResult;
    // Fall through to Hono for everything else
    return app.fetch(req, server);
  },
  websocket: terminalWebSocket,
  port: PORT,
  hostname: HOST,
  idleTimeout: 255,
  tls: HARNESS_TLS_CERT && HARNESS_TLS_KEY
    ? {
        cert: Bun.file(HARNESS_TLS_CERT),
        key: Bun.file(HARNESS_TLS_KEY),
      }
    : undefined,
});
const authModes = [AUTH_TOKEN && "token", getPin() && "pin"].filter(Boolean);
const protocol = HARNESS_TLS_CERT && HARNESS_TLS_KEY ? "https" : "http";
console.log(`Agent harness listening on ${protocol}://${HOST}:${PORT}${authModes.length ? ` (auth: ${authModes.join("+")})` : ""}`);

initActions();
loadPrompts();

// Suppress AbortError rejections from provider internals (e.g. Gemini CLI retry loops)
process.on("unhandledRejection", (reason) => {
  if (reason && typeof reason === "object" && (reason as any).name === "AbortError") return;
  console.error("Unhandled rejection:", reason);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  stopActions();
  shutdownAll();
  shutdownAllTerminals();
  server.stop();
  setTimeout(() => process.exit(0), 3000);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
