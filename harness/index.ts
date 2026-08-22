// Prevent nested session detection when launched from within Claude Code
delete process.env.CLAUDECODE;

import { loadSecrets, resolveSecret, isSecretSet, getSecretsInfo, setupPin, changePin, disablePin, resetPin } from "./secrets";
import { BrowserSessionStore } from "./browser-auth";
import { probeClaudeAccount } from "./claude-account";
import { rehydrateHome } from "./modus-home-rehydrate";
loadSecrets();

// Ensure the current Vault home exists. Main may migrate the checkout's legacy
// profiles; named Vaults seed shipped templates only. Must run before profile reads.
{
  const report = rehydrateHome();
  const total = report.copiedFromLegacy.length + report.copiedFromTemplates.length;
  if (total > 0) {
    console.log(
      `[modus-home] rehydrated current Vault home — ${report.copiedFromLegacy.length} from legacy, ${report.copiedFromTemplates.length} from templates`,
    );
  }
}

import { join, resolve, extname, dirname } from "path";
import { APP_PATHS } from "./app-paths";
import { initHarnessBridge } from "./harness-bridge";
import { cursorMcpConfigStore } from "./providers/cursor-mcp-config";
import { pruneAbandonedSensitiveTempDirectories } from "./sensitive-temp";
import { isSessionMcpCredential, validateSessionMcpCredential } from "./session-mcp-credential";
import { FILE_TICKET_TTL_MS, mintFileTicket, validateFileTicket } from "./file-ticket";
import { moveAssetETag, moveAssetHeaders, moveAssetNotModified } from "./move-asset-cache";
import { formatClientTimingLog, parseClientTimingPayload } from "./client-timing";
import { BACKEND_IDENTITY } from "./backend-identity";
import { configuredRootsForCwd } from "./preview-roots";
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  getAllProfiles, getProfile, listProfileNames,
  getProfileConfig, getProfileConfigPath, getProfileUiConfig, saveProfile, saveProfileUiConfig, patchProfileUiConfig, deleteProfile, getGlobalConfig, saveGlobalConfig, getStoredGlobalConfig,
  setUserName, getUserName,
  getUserProfile, getUserProfileConfig, getUserProfileUiConfig, listUserProfileNames, getAllUserProfiles,
  saveUserProfile, saveUserProfileUiConfig, patchUserProfileUiConfig, deleteUserProfile,
  getUserProfileState, patchUserProfileState,
  listProjects, getProjectById, getProjectByPath, updateProjectPath,
} from "./profiles";
import { initProject, getInitStatus } from "./init";
// Gemini usage is loaded lazily so its external Antigravity auth probe runs only when requested.
import { getSessionCommitAttribution } from "./commit-attribution";
import {
  getUiState, listThemes, listFonts, getTheme, getFont, getActiveTheme, getActiveFont,
  registerTheme, registerFont, activateTheme, activateFont, patchTheme, patchFont,
} from "./project-ui";
import { forkConfigPage, listConfigPages } from "./pages";
import { listDocs, getDoc, searchDocs, type DocAudience } from "./docs-registry";
import { getAboutInfo } from "./about";
import {
  listClientExtensions, getClientExtensionById, resolveExtensionSettings, extensionSettingScope,
} from "./client-extensions";
import { settingNumberError } from "./settings-schema";
import { fileMutationFailure } from "./file-mutation-errors";
import {
  listModusPlugins, patchModusPlugin, registerModusPlugin, unregisterModusPlugin,
} from "./modus-plugins";
import {
  createVaultForApi,
  getVaultPolicyForApi,
  listVaultsForApi,
  repairVaultForApi,
  setVaultPolicyForApi,
  updateVaultForApi,
} from "./vault-api";
import { getInstalledSkill, listInstalledSkills, listPluginSkills, buildSkillPayload } from "./skills";
import {
  getPluginSettings,
  patchPluginSettings as patchScopedPluginSettings,
} from "./plugin-settings";
import { getResolvedClientExtensionsConfig } from "./profiles";
import { resolveWhisperCredential } from "./whisper-credential";
import { resolveWhisperEndpoint, describeWhisperFetchFailure } from "./whisper-endpoint";
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
  getSession, getStoredSessionConfig, archiveSession, unarchiveSession, listArchivedSessions, searchSessions,
  getEvents, upsertSession as dbUpsertSession,
  getMaxSeq,
  getDraft, setDraft, getSessionUiState, patchSessionUiState,
  getWebPositions, upsertWebPositions, deleteWebPositions,
  updateSessionTitle,
  getSessionTags, getSessionByTag, updateSessionTags, addSessionTag, removeSessionTag, parseTags,
  pruneSessionEvents, pruneAllSessionEvents, storageStats, getSessionStats, getPeriodCosts,
  getProviderUsageAnalytics, getDeepAnalytics,
  getSessionMessage, getSessionMessages, getSessionMessageHistory, getSessionTurnIndex, getSessionArtifact, getFileObservations, getSessionsForFile, listAllCheckpoints,
} from "./db";
import { planCheckpointMaintenance } from "./checkpoint-maintenance";
import { resolveMcpServers } from "./mcp-config";
import { logActivity, getActivityLog, getActivitySummary } from "./activity";
import { onSessionEvent } from "./action-runner";
import {
  startSession, startSessionWithMoves, interactWithSession, queueMessage, steerMessage, stopSession, stopTask,
  getActiveSession, getAllActiveSessions, subscribe, shutdownAll,
  updateSessionConfig, resolvePermission, switchProfile,
  pauseSession, resumeSession, branchSession, previewSessionBranch,
  previewSessionCheckpoint, restoreSessionCheckpoint, cancelQueuedDispatch,
  subscribeGlobal, emitGlobalSessionEvent,
  startSessionReaper, stopSessionReaper,
  type SSEWriter,
} from "./session-manager";
import { startMemoryWatchdog, stopMemoryWatchdog, getMemoryStatus } from "./memory-guard";
import {
  createTerminal, killTerminal, resizeTerminal as resizeTerminalPty,
  getActiveTerminal, getAllActiveTerminals, getTerminalInfo, listAllTerminals,
  shutdownAllTerminals,
} from "./terminal-manager";
import { closeTerminalWebSockets, tryUpgradeTerminalWS, terminalWebSocket, setAuthChecker, setOriginChecker } from "./terminal-ws";
import { getProcessSnapshot, killProcess } from "./process-registry";
import { getPromptCache, savePromptCache, type PromptCache } from "./prompt-cache";
import { startWatching, subscribeFsEvents, type FsChangeEvent } from "./fs-watcher";
import {
  initShadowRepo, scheduleCommit, listCommits, onShadowCommit,
  shadowRepoPath, gitShowFile, gitDiffTree, gitHead, gitLsTree, getWorkTree,
  recordAttributionHint, setCommitsPausedCheck,
  type ShadowScope,
  type ActorInfo,
} from "./workspace-history";
import { isTracked } from "./workspace-history-filter";
import {
  buildProjectDescriptors,
  resolveSessionProject,
  type SessionProjectDescriptor,
} from "./session-projects";
import { projectEntities, userEntities } from "./workspace-entities";
import {
  openIndex, getIndex, indexCommit, getStoredHead, rebuildIndex, queryChanges,
  getChange, getEntityRevisions, listEntityStates, getEntityState,
  type DiffTreeEntry,
} from "./workspace-history-index";
import { entityDiff } from "./workspace-history-diff";
import { pin, unpin, listPins } from "./workspace-history-retention";
import {
  planRestore, applyRestore, discardPlan, isCommitsPaused,
  type RestoreTarget, type EntitySelection,
} from "./workspace-history-restore";
import { homeProfilesDir } from "./modus-home";
import {
  PinAttemptThrottle,
  isAllowedBrowserOrigin,
  isLoopbackAddress,
  requestSourceKey,
} from "./security-boundary";
import {
  getTextToSpeechConfig,
  getTextToSpeechHealth,
  listTextToSpeechVoices,
  openAiSpeechToTtsRequest,
  parseTtsProviderId,
  patchTextToSpeechConfig,
  synthesizeSpeech,
} from "./tts";

let PORT = Number(process.env.HARNESS_PORT ?? 3777);
const HOST = process.env.HARNESS_HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.HARNESS_TOKEN || "";
const UI_DIST_DIR = resolve(APP_PATHS.resourcesDir, "ui/dist");
const UI_INDEX_PATH = join(UI_DIST_DIR, "index.html");

type FileSearchHit = {
  path: string;
  name: string;
  parent: string;
};

function readNumericEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function splitSearchPath(filePath: string): FileSearchHit {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return {
    path: filePath,
    name: slash === -1 ? normalized : normalized.slice(slash + 1),
    parent: slash === -1 ? "" : normalized.slice(0, slash),
  };
}

function isWithinRoot(filePath: string, root: string): boolean {
  const target = resolve(filePath);
  const base = resolve(root);
  if (process.platform === "win32") {
    return target.toLowerCase() === base.toLowerCase() || target.toLowerCase().startsWith(`${base.toLowerCase()}\\`) || target.toLowerCase().startsWith(`${base.toLowerCase()}/`);
  }
  return target === base || target.startsWith(`${base}/`);
}

type PreviewKind = "directory" | "html" | "image" | "audio" | "video" | "pdf" | "text" | "binary";

const PREVIEW_MIME: Record<string, { mime: string; kind: PreviewKind; safe?: boolean; warning?: string }> = {
  ".html": { mime: "text/html; charset=utf-8", kind: "html", safe: false, warning: "HTML is rendered in a sandboxed frame." },
  ".htm": { mime: "text/html; charset=utf-8", kind: "html", safe: false, warning: "HTML is rendered in a sandboxed frame." },
  ".webp": { mime: "image/webp", kind: "image" },
  ".png": { mime: "image/png", kind: "image" },
  ".jpg": { mime: "image/jpeg", kind: "image" },
  ".jpeg": { mime: "image/jpeg", kind: "image" },
  ".gif": { mime: "image/gif", kind: "image" },
  ".bmp": { mime: "image/bmp", kind: "image" },
  ".ico": { mime: "image/x-icon", kind: "image" },
  ".avif": { mime: "image/avif", kind: "image" },
  ".tiff": { mime: "image/tiff", kind: "image" },
  ".tif": { mime: "image/tiff", kind: "image" },
  ".svg": { mime: "image/svg+xml", kind: "image", safe: false, warning: "SVG may contain active content; it is shown as an image." },
  ".wav": { mime: "audio/wav", kind: "audio" },
  ".mp3": { mime: "audio/mpeg", kind: "audio" },
  ".ogg": { mime: "audio/ogg", kind: "audio" },
  ".m4a": { mime: "audio/mp4", kind: "audio" },
  ".aac": { mime: "audio/aac", kind: "audio" },
  ".flac": { mime: "audio/flac", kind: "audio" },
  ".mp4": { mime: "video/mp4", kind: "video" },
  ".webm": { mime: "video/webm", kind: "video" },
  ".mov": { mime: "video/quicktime", kind: "video" },
  ".mkv": { mime: "video/x-matroska", kind: "video" },
  ".avi": { mime: "video/x-msvideo", kind: "video" },
  ".pdf": { mime: "application/pdf", kind: "pdf", safe: false, warning: "PDF preview is browser-rendered." },
  ".md": { mime: "text/markdown; charset=utf-8", kind: "text" },
  ".mdx": { mime: "text/markdown; charset=utf-8", kind: "text" },
  ".txt": { mime: "text/plain; charset=utf-8", kind: "text" },
  ".log": { mime: "text/plain; charset=utf-8", kind: "text" },
  ".json": { mime: "application/json; charset=utf-8", kind: "text" },
  ".css": { mime: "text/css; charset=utf-8", kind: "text" },
  ".js": { mime: "text/javascript; charset=utf-8", kind: "text" },
  ".ts": { mime: "text/plain; charset=utf-8", kind: "text" },
  ".tsx": { mime: "text/plain; charset=utf-8", kind: "text" },
};

function previewInfoForPath(filePath: string, isDirectory = false) {
  if (isDirectory) return { mime: "inode/directory", kind: "directory" as PreviewKind, safe: true, warnings: [] as string[] };
  const ext = extname(filePath).toLowerCase();
  const info = PREVIEW_MIME[ext] ?? { mime: "application/octet-stream", kind: "binary" as PreviewKind };
  const safe = info.safe ?? (info.kind !== "html" && info.kind !== "pdf");
  return { mime: info.mime, kind: info.kind, safe, warnings: info.warning ? [info.warning] : [] };
}

function previewIdForPath(filePath: string): string {
  return Buffer.from(resolve(filePath), "utf-8").toString("base64url");
}

function pathFromPreviewId(id: string): string | null {
  try { return Buffer.from(id, "base64url").toString("utf-8"); } catch { return null; }
}

function relativeLabel(filePath: string, roots: string[]): string {
  const target = resolve(filePath);
  const root = roots.find((r) => isWithinRoot(target, r));
  if (!root) return target;
  const rel = target.slice(resolve(root).length).replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return rel || target;
}

function previewRoots(params: URLSearchParams): string[] {
  const roots = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim()) roots.add(resolve(value));
  };
  const sessionId = params.get("sessionId");
  if (sessionId) {
    const active = getActiveSession(sessionId);
    const stored = getStoredSessionConfig(sessionId);
    const row = getSession(sessionId);
    add(active?.cwd ?? stored?.cwd ?? row?.cwd);
    for (const dir of active?.additionalDirectories ?? stored?.additionalDirectories ?? []) add(dir);
  }
  const userProfileName = params.get("userProfile");
  if (userProfileName) {
    const up = getUserProfile(userProfileName);
    for (const project of up?.projects ?? []) add(project);
  }
  for (const project of listProjects()) add(project.path);
  const cwd = params.get("cwd");
  if (cwd) {
    // The UI can know the active project before its user-profile hydration has
    // completed. Authorize that explicit cwd against configured profile roots
    // instead of requiring the transient userProfile query parameter. Merely
    // passing an arbitrary cwd still grants nothing.
    const configuredProfileRoots = Object.values(getAllUserProfiles())
      .flatMap((profile) => profile.projects ?? [])
      .map((project) => resolve(project));
    for (const root of configuredRootsForCwd(cwd, [...roots], configuredProfileRoots)) add(root);
  }
  return [...roots];
}

function assertPreviewAllowed(filePath: string, roots: string[]): string | null {
  const target = resolve(filePath);
  if (roots.some((root) => isWithinRoot(target, root))) return null;
  return "path is outside configured preview roots";
}

async function buildPreviewManifest(filePath: string, roots: string[], scopeQuery = "") {
  const { stat } = await import("fs/promises");
  const target = resolve(filePath);
  const info = await stat(target);
  const preview = previewInfoForPath(target, info.isDirectory());
  const id = previewIdForPath(target);
  const name = target.replace(/\\/g, "/").split("/").pop() || target;
  return {
    id,
    path: target,
    pathLabel: relativeLabel(target, roots),
    name,
    kind: preview.kind,
    mime: preview.mime,
    size: info.isDirectory() ? null : info.size,
    safe: preview.safe,
    warnings: preview.warnings,
    urls: info.isDirectory() ? {} : { raw: `/api/preview/file/${encodeURIComponent(id)}${scopeQuery ? `?${scopeQuery}` : ""}` },
    actions: ["preview", "download", "openInEditor", "copyPath"],
  };
}

async function searchFilesWithEverything(root: string, query: string, limit: number) {
  if (process.platform !== "win32") {
    return {
      available: false,
      provider: "none" as const,
      installHint: "Everything search is currently supported on Windows with es.exe available on PATH.",
      results: [],
    };
  }

  const candidatePaths = [
    Bun.which("es.exe"),
    Bun.which("es"),
    process.env.PROGRAMFILES ? join(process.env.PROGRAMFILES, "Everything", "es.exe") : null,
    process.env["PROGRAMFILES(X86)"] ? join(process.env["PROGRAMFILES(X86)"], "Everything", "es.exe") : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Everything", "es.exe") : null,
  ].filter((value): value is string => Boolean(value));

  const esPath = candidatePaths.find((candidate) => existsSync(candidate));
  if (!esPath) {
    return {
      available: false,
      provider: "none" as const,
      installHint: "Everything file search needs es.exe available on PATH or installed alongside Everything.",
      results: [],
    };
  }

  const proc = Bun.spawn({
    cmd: [esPath, "-path", root, "-n", String(limit), "-sort", "path-ascending", query],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      available: false,
      provider: "none" as const,
      installHint: stderrText.trim() || "Everything is installed but did not accept the search request. Make sure Everything is running.",
      results: [],
    };
  }

  const results = stdoutText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => isWithinRoot(filePath, root))
    .map(splitSearchPath);

  return {
    available: true,
    provider: "everything" as const,
    results,
  };
}
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
    pageNav,
    layouts,
    computer,
    editor,
    interface: interfaceConfig,
    clientExtensions,
    ...core
  } = body;
  const ui = {
    ...(dashboard !== undefined ? { dashboard } : {}),
    ...(leftPanel !== undefined ? { leftPanel } : {}),
    ...(pageNav !== undefined ? { pageNav } : {}),
    ...(layouts !== undefined ? { layouts } : {}),
    ...(computer !== undefined ? { computer } : {}),
    ...(editor !== undefined ? { editor } : {}),
    ...(interfaceConfig !== undefined ? { interface: interfaceConfig } : {}),
    ...(clientExtensions !== undefined ? { clientExtensions } : {}),
  };
  return Object.keys(ui).length > 0 ? { core, ui } : { core };
}

// Browser-origin boundary. CLI/SDK requests normally omit Origin and remain
// valid; browser requests must come from a known Modus UI origin.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && !isAllowedBrowserOrigin(origin, {
    port: PORT,
    requestHost: c.req.header("Host"),
    configuredOrigins: process.env.MODUS_ALLOWED_ORIGINS,
  })) {
    return c.json({ error: "foreign browser origin rejected" }, 403);
  }
  return next();
});
app.use("/api/*", cors({
  origin: (origin, c) => isAllowedBrowserOrigin(origin, {
    port: PORT,
    requestHost: c.req.header("Host"),
    configuredOrigins: process.env.MODUS_ALLOWED_ORIGINS,
  }) ? origin : "",
  // Any custom request header a client sends must be listed here or the browser
  // blocks the request at preflight — before it reaches a route, so nothing is
  // logged server-side and the failure is invisible from both ends. This only
  // bites cross-origin callers: the desktop shell runs on tauri.localhost and
  // talks to the backend on 127.0.0.1, while a browser served by the harness is
  // same-origin and never preflights. X-Whisper-Url is legacy and no longer read
  // by any route — the whisper endpoint is backend config now, resolved server
  // side — but it stays allowed so an older client's request is not dropped at
  // preflight, which would fail silently at both ends.
  allowHeaders: ["Authorization", "Content-Type", "X-Whisper-Url"],
  allowMethods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  exposeHeaders: ["Accept-Ranges", "Content-Length", "Content-Range", "Content-Type"],
}));

// The desktop dev UI is served from localhost:5180 while it talks to the
// managed harness on 127.0.0.1:<dynamic port>. Health is intentionally public,
// but it still needs an allow-origin response for that browser health probe.
app.use("/health", cors({
  origin: (origin, c) => isAllowedBrowserOrigin(origin, {
    port: PORT,
    requestHost: c.req.header("Host"),
    configuredOrigins: process.env.MODUS_ALLOWED_ORIGINS,
  }) ? origin : "",
  allowMethods: ["GET", "OPTIONS"],
}));

// ── PIN Auth (browser gate) ──
// If HARNESS_PIN is set, browsers must verify the PIN to get access.
// Agents using HARNESS_TOKEN (Bearer header) bypass the PIN gate entirely.

/** Dynamic PIN lookup — picks up changes from first-run setup */
function getPin() { return resolveSecret("HARNESS_PIN"); }

// In-memory browser sessions die on restart and have idle + absolute ceilings.
const browserSessions = new BrowserSessionStore();
browserSessions.onRevoke(closeTerminalWebSockets);
const pinThrottle = new PinAttemptThrottle();

function bearerToken(c: any): string {
  const header = c.req.header("Authorization");
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

function isAgentBearer(c: any): boolean {
  return !!AUTH_TOKEN && bearerToken(c) === AUTH_TOKEN;
}

function hasLocalAuthAdmin(c: any): boolean {
  if (isAgentBearer(c)) return true;
  if (AUTH_TOKEN) return false;
  const source = requestSourceKey(
    c.req.header("X-Modus-Peer-Address"),
    c.req.header("X-Forwarded-For"),
  );
  const host = (c.req.header("Host") ?? "").split(":")[0]!.toLowerCase();
  return isLoopbackAddress(source) && !host.endsWith(".ts.net");
}

function operatorKind(c: any, allowQuery = false): "agent" | "browser" | null {
  const bearer = bearerToken(c);
  if (AUTH_TOKEN && bearer === AUTH_TOKEN) return "agent";
  if (browserSessions.validate(bearer)) return "browser";
  if (allowQuery) {
    // Only a bounded, revocable browser-session token may ride in a URL.
    //
    // A URL leaks in ways a header does not: copied links, browser history,
    // referrers, and proxy access logs. The supervisor bearer authenticates
    // every API including file and profile mutation and cannot be revoked
    // without restarting the backend, so it is never accepted from a query
    // string. Browser clients exchange it for a session token at bind time
    // (POST /api/auth/exchange).
    const token = new URL(c.req.url).searchParams.get("token") ?? "";
    if (browserSessions.validate(token)) return "browser";
  }
  if (!AUTH_TOKEN && !getPin()) return "browser";
  return null;
}

function allowsQueryCredential(c: any): boolean {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  const path = c.req.path as string;
  return path === "/api/events/sessions"
    || path === "/api/events/fs"
    || path === "/api/events/multi"
    // `/api/file/raw` is deliberately NOT here. It reads any path on the machine,
    // so a shareable URL for it must not carry a whole-API credential — it takes
    // a path-bound ticket instead (see file-ticket.ts).
    || /^\/api\/preview\/file\/[^/]+$/.test(path)
    || /^\/api\/git\/raw\//.test(path)
    || /^\/api\/sessions\/[^/]+\/artifacts\/[^/]+$/.test(path)
    || /^\/api\/moves\/[^/]+\/widget(?:\.css)?$/.test(path);
}

function browserSessionToken(c: any, allowQuery = false): string {
  const bearer = bearerToken(c);
  if (browserSessions.validate(bearer, Date.now(), false)) return bearer;
  if (allowQuery) {
    const query = new URL(c.req.url).searchParams.get("token") ?? "";
    if (browserSessions.validate(query, Date.now(), false)) return query;
  }
  return "";
}

function registerBrowserConnection(c: any, close: () => void, allowQuery = false): () => void {
  const token = browserSessionToken(c, allowQuery);
  return token ? browserSessions.registerConnection(token, close) : () => {};
}

function requireOperator(c: any): Response | null {
  return operatorKind(c) ? null : c.json({ error: "authenticated Modus session required" }, 401);
}

function requireLocalAuthAdmin(c: any): Response | null {
  return hasLocalAuthAdmin(c)
    ? null
    : c.json({ error: "PIN administration is available only from the local Modus host" }, 403);
}

function pinSource(c: any): string {
  return requestSourceKey(c.req.header("X-Modus-Peer-Address"), c.req.header("X-Forwarded-For"));
}

function pinThrottleResponse(c: any): Response | null {
  const decision = pinThrottle.check(pinSource(c));
  if (decision.allowed) return null;
  c.header("Retry-After", String(decision.retryAfterSeconds));
  return c.json({ error: "too many PIN attempts", retryAfterSeconds: decision.retryAfterSeconds }, 429);
}

function recordPinFailure(c: any): Response | null {
  const decision = pinThrottle.recordFailure(pinSource(c));
  if (decision.allowed) return null;
  c.header("Retry-After", String(decision.retryAfterSeconds));
  return c.json({ error: "too many PIN attempts", retryAfterSeconds: decision.retryAfterSeconds }, 429);
}

function mintBrowserSessionToken(): string {
  return browserSessions.mint().token;
}

// Check if PIN auth is required (no value exposed)
app.get("/api/auth/status", (c) => {
  const pin = getPin();
  const name = getUserName();
  return c.json({
    required: !!pin,
    setup: !pin && !name,
    pinEnabled: !!pin,
    needsName: !name,
    name,
    tokenRequired: !!AUTH_TOKEN,
    canManagePin: hasLocalAuthAdmin(c),
    backend: BACKEND_IDENTITY,
  });
});

// First-run identity setup — PIN is optional and can be enabled later.
app.post("/api/auth/name", async (c) => {
  if (getPin()) {
    const denied = requireOperator(c);
    if (denied) return denied;
  }
  const body = await c.req.json();
  const name = body.name?.trim();
  if (!name) return c.json({ error: "name required" }, 400);
  setUserName(name);
  const token = !getPin() && AUTH_TOKEN ? mintBrowserSessionToken() : "";
  return c.json({ ok: true, name, token });
});

// Create a browser session when PIN auth is disabled but HARNESS_TOKEN protects APIs.
app.post("/api/auth/session", (c) => {
  if (getPin()) return c.json({ error: "PIN verification required" }, 403);
  const token = AUTH_TOKEN ? mintBrowserSessionToken() : "";
  return c.json({ ok: true, token });
});

/**
 * Exchange a header-presented operator credential for a browser session token.
 *
 * Resource URLs that a browser constructs itself (media elements, EventSource)
 * cannot carry an Authorization header, so they carry a token in the query
 * string. Only bounded, revocable session tokens are accepted there, so a client
 * holding the supervisor bearer — notably the managed desktop shell — trades it
 * for one here instead of putting the supervisor credential into URLs.
 *
 * Requires a header credential: this route never reads a query token, and the
 * minted session inherits revocation on lock and PIN change.
 */
app.post("/api/auth/exchange", (c) => {
  if (!AUTH_TOKEN && !getPin()) return c.json({ ok: true, token: "" });
  const kind = operatorKind(c);
  if (!kind) return c.json({ error: "unauthorized" }, 401);
  return c.json({ ok: true, token: mintBrowserSessionToken() });
});

// First-run setup — set PIN from UI, only if none exists yet
app.post("/api/auth/setup", async (c) => {
  const denied = requireLocalAuthAdmin(c);
  if (denied) return denied;
  const throttled = pinThrottleResponse(c);
  if (throttled) return throttled;
  if (getPin()) {
    const blocked = recordPinFailure(c);
    return blocked ?? c.json({ error: "pin already set" }, 403);
  }
  const body = await c.req.json();
  const pin = body.pin?.trim();
  const name = body.name?.trim();
  if (!pin || pin.length < 4) {
    const blocked = recordPinFailure(c);
    return blocked ?? c.json({ error: "pin must be at least 4 characters" }, 400);
  }
  const ok = setupPin(pin);
  if (!ok) {
    const blocked = recordPinFailure(c);
    return blocked ?? c.json({ error: "pin already set" }, 403);
  }
  pinThrottle.recordSuccess(pinSource(c));
  if (name) setUserName(name);
  browserSessions.revokeAll();
  return c.json({ ok: true });
});

// Verify PIN — returns a session token for the browser
app.post("/api/auth/verify", async (c) => {
  const throttled = pinThrottleResponse(c);
  if (throttled) return throttled;
  const pin = getPin();
  if (!pin) return c.json({ ok: true, token: AUTH_TOKEN ? mintBrowserSessionToken() : "" });
  const body = await c.req.json();
  if (body.pin === pin) {
    const sessionToken = mintBrowserSessionToken();
    const name = body.name?.trim();
    if (name) setUserName(name);
    pinThrottle.recordSuccess(pinSource(c));
    return c.json({ ok: true, token: sessionToken });
  }
  const blocked = recordPinFailure(c);
  return blocked ?? c.json({ error: "wrong pin" }, 401);
});

// Get current user display name
app.get("/api/auth/me", (c) => {
  const denied = requireOperator(c);
  if (denied) return denied;
  return c.json({ name: getUserName() });
});

// Lightweight browser auth validity check.
// This stays cheap even when session routes are under load.
app.get("/api/auth/check", (c) => {
  // Auth endpoints bypass the global auth middleware, so this route must
  // validate the presented token itself.
  if (!AUTH_TOKEN && !getPin()) return c.json({ ok: true });

  const kind = operatorKind(c);
  if (kind) return c.json({ ok: true, kind });
  return c.json({ error: "unauthorized" }, 401);
});

// Lock — invalidate ALL browser sessions (agents unaffected)
app.post("/api/auth/lock", (c) => {
  const denied = requireOperator(c);
  if (denied) return denied;
  if (!getPin()) return c.json({ error: "enable a PIN before locking remote browser access" }, 409);
  browserSessions.revokeAll();
  return c.json({ ok: true });
});

// Change PIN — requires old PIN to verify identity
app.post("/api/auth/change-pin", async (c) => {
  const denied = requireLocalAuthAdmin(c);
  if (denied) return denied;
  const throttled = pinThrottleResponse(c);
  if (throttled) return throttled;
  const body = await c.req.json();
  const oldPin = body.oldPin?.trim();
  const newPin = body.newPin?.trim();
  if (!oldPin || !newPin) return c.json({ error: "oldPin and newPin are required" }, 400);
  if (newPin.length < 4) return c.json({ error: "new PIN must be at least 4 characters" }, 400);
  const ok = changePin(oldPin, newPin);
  if (!ok) {
    const blocked = recordPinFailure(c);
    return blocked ?? c.json({ error: "wrong PIN" }, 401);
  }
  pinThrottle.recordSuccess(pinSource(c));
  browserSessions.revokeAll();
  return c.json({ ok: true });
});

// Local recovery â€” the desktop/host token can replace a forgotten PIN.
app.post("/api/auth/reset-pin", async (c) => {
  const denied = requireLocalAuthAdmin(c);
  if (denied) return denied;
  const body = await c.req.json();
  const newPin = body.newPin?.trim();
  if (!newPin || newPin.length < 4) return c.json({ error: "new PIN must be at least 4 characters" }, 400);
  if (!resetPin(newPin)) return c.json({ error: "environment-managed PIN cannot be reset at runtime" }, 409);
  browserSessions.revokeAll();
  return c.json({ ok: true });
});

// Disable PIN auth. Only works for PINs managed in the secrets file.
app.post("/api/auth/disable-pin", async (c) => {
  const denied = requireLocalAuthAdmin(c);
  if (denied) return denied;
  const pin = getPin();
  if (!pin) return c.json({ error: "PIN is not enabled" }, 409);
  const ok = disablePin(pin);
  if (!ok) {
    return c.json({ error: "environment-managed PIN cannot be disabled at runtime" }, 409);
  }
  browserSessions.revokeAll();
  return c.json({ ok: true });
});

// Token auth — skip if no HARNESS_TOKEN is set
// Also allows PIN-derived session tokens
app.use("/api/*", async (c, next) => {
  const bearer = bearerToken(c);
  if (isSessionMcpCredential(bearer)) {
    return validateSessionMcpCredential(bearer, c.req.path)
      ? next()
      : c.json({ error: "unauthorized" }, 401);
  }

  // Auth endpoints are always open
  if (c.req.path.startsWith("/api/auth/")) return next();

  // Webhook action endpoints use their own token auth (action-level, not harness-level)
  if (/^\/api\/actions\/[^/]+\/hook$/.test(c.req.path)) return next();

  // If neither HARNESS_TOKEN nor HARNESS_PIN is set, no auth at all
  if (!AUTH_TOKEN && !getPin()) return next();

  if (operatorKind(c, allowsQueryCredential(c))) return next();

  // A path-bound file ticket authorizes one raw-file read and nothing else. It
  // is checked last, so it can never widen an otherwise-authorized request.
  if (validFileTicketRequest(c)) return next();

  return c.json({ error: "unauthorized" }, 401);
});

/** True when this is a `/api/file/raw` read carrying a live ticket for that exact file. */
function validFileTicketRequest(c: any): boolean {
  if (c.req.path !== "/api/file/raw") return false;
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return false;
  const params = new URL(c.req.url).searchParams;
  const ticket = params.get("ticket") ?? "";
  const filePath = params.get("path") ?? "";
  if (!ticket || !filePath) return false;
  return validateFileTicket(ticket, filePath);
}

function requireConfiguredFileApiAuth(c: any): Response | null {
  if (AUTH_TOKEN || getPin()) return null;
  return c.json({ error: "file APIs require HARNESS_TOKEN or HARNESS_PIN" }, 401);
}

// ── Health ──

app.get("/health", (c) => {
  const all = getAllActiveSessions();
  const live = all.filter(s => s.status === "running" || s.status === "starting");
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    activeSessions: live.length,
    totalInMap: all.length,
    byStatus: all.reduce((acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; }, {} as Record<string, number>),
  });
});

// Release Tauri has no DevTools, so renderer timings would otherwise be
// invisible on the surface we ship. Keep this authenticated, structured, and
// bounded; arbitrary client text must never become a log-injection primitive.
app.post("/api/client-timing", async (c) => {
  const payload = parseClientTimingPayload(await c.req.json().catch(() => null));
  if (!payload) return c.json({ error: "invalid client timing payload" }, 400);
  console.log(formatClientTimingLog(payload));
  return c.body(null, 204);
});

// ── Process Registry ──

// Unified view of every managed process (sessions, mission workers, terminals)
app.get("/api/processes", (c) => {
  return c.json(getProcessSnapshot());
});

// ── Prompt Cache ──

app.get("/api/prompt-cache", (c) => {
  return c.json(getPromptCache());
});

app.put("/api/prompt-cache", async (c) => {
  const body = await c.req.json<PromptCache>();
  if (!body || !Array.isArray(body.prompts)) {
    return c.json({ error: "invalid prompt cache payload" }, 400);
  }
  savePromptCache(body);
  return c.json({ ok: true });
});

// Kill a managed process by session ID
app.delete("/api/processes/:id", (c) => {
  const id = c.req.param("id");
  const result = killProcess(id);
  return result.ok ? c.json({ ok: true }) : c.json(result, 404);
});

// ── Admin ──

// Internal shutdown — called by watchdog to trigger graceful exit (closes connections, frees port)
app.post("/api/internal/shutdown", (c) => {
  setTimeout(async () => {
    stopActions();
    stopSessionReaper();
    stopMemoryWatchdog();
    // Await provider teardown: it reaps the provider CLI subprocess, and exiting
    // out from under it orphans that process rather than killing it.
    await shutdownAll();
    shutdownAllTerminals();
    server.stop(true);
    setTimeout(() => process.exit(0), 500);
  }, 50);
  return c.json({ ok: true });
});

app.get("/api/system/memory", (c) => c.json(getMemoryStatus()));

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
  const sentinelPath = join(APP_PATHS.runtimeDir, ".watchdog-restart");
  await Bun.write(sentinelPath, Date.now().toString());

  // Respond before shutting down
  const response = c.json({ ok: true, restarting: true });

  // Shut down after response flushes (~100ms)
  setTimeout(async () => {
    await shutdownAll();
    server.stop(true);
    await Bun.sleep(200);
    process.exit(0);
  }, 100);

  return response;
});

// ── Profiles ──

app.get("/api/profiles", (c) => {
  const cwd = c.req.query("cwd");
  // `ui=1` resolves each profile's UI config inline. The client needs it for
  // every profile it lists, and fetching it per profile turned one navigation
  // into 1+N round trips — the cost is a local config read, not I/O worth a
  // separate request each.
  const withUi = c.req.query("ui") === "1";
  const all = getAllProfiles(cwd);
  const list = Object.entries(all).map(([name, p]) => ({
    ...p,
    name,
    tools: p.tools ?? "all",
    ...(withUi ? { ui: getProfileUiConfig(name, cwd) ?? p.ui ?? {} } : {}),
  }));
  return c.json(list);
});

app.get("/api/profiles/_global", (c) => {
  const cwd = c.req.query("cwd");
  return c.json(c.req.query("stored") === "1" ? getStoredGlobalConfig(cwd) : getGlobalConfig(cwd));
});

app.put("/api/profiles/_global", async (c) => {
  const cwd = c.req.query("cwd");
  const body = await c.req.json();
  const v = validate(GlobalConfigSchema, body);
  if (!v.ok) return c.json({ error: "validation failed", details: v.errors }, 400);
  saveGlobalConfig(body, cwd);
  return c.json({ ok: true });
});

// ── Text To Speech ──

app.get("/api/tts/config", (c) => {
  return c.json(getTextToSpeechConfig(c.req.query("cwd")));
});

app.patch("/api/tts/config", async (c) => {
  const cwd = c.req.query("cwd");
  const body = await c.req.json();
  const current = getGlobalConfig(cwd);
  const candidate = { ...current, textToSpeech: { ...(current.textToSpeech ?? {}), ...body } };
  const v = validate(GlobalConfigSchema, candidate);
  if (!v.ok) return c.json({ error: "validation failed", details: v.errors }, 400);
  return c.json(patchTextToSpeechConfig(body, cwd));
});

app.get("/api/tts/health", async (c) => {
  return c.json(await getTextToSpeechHealth(c.req.query("cwd")));
});

app.get("/api/tts/voices", async (c) => {
  try {
    const provider = parseTtsProviderId(c.req.query("provider"));
    return c.json(await listTextToSpeechVoices(provider, c.req.query("cwd")));
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to list voices" }, 400);
  }
});

app.post("/api/tts/speech", async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const result = await synthesizeSpeech({
      cwd: c.req.query("cwd"),
      text: String(body.text ?? body.input ?? ""),
      voice: typeof body.voice === "string" ? body.voice : undefined,
      provider: parseTtsProviderId(body.provider),
      model: typeof body.model === "string" ? body.model : undefined,
      format: body.format === "mp3" || body.format === "pcm" || body.format === "wav" ? body.format : undefined,
      speed: typeof body.speed === "number" ? body.speed : undefined,
    });
    return new Response(result.data, {
      headers: {
        "Content-Type": result.mime,
        "Content-Disposition": `inline; filename="speech${result.extension}"`,
        "X-TTS-Provider": result.provider,
        "X-TTS-Voice": result.voice,
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message ?? "TTS failed" }, 400);
  }
});

app.post("/v1/audio/speech", async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const result = await synthesizeSpeech(openAiSpeechToTtsRequest(body, c.req.query("cwd")));
    return new Response(result.data, {
      headers: {
        "Content-Type": result.mime,
        "Content-Disposition": `inline; filename="speech${result.extension}"`,
        "X-TTS-Provider": result.provider,
        "X-TTS-Voice": result.voice,
      },
    });
  } catch (err: any) {
    return c.json({ error: err.message ?? "TTS failed" }, 400);
  }
});

app.get("/v1/audio/voices", async (c) => {
  try {
    return c.json(await listTextToSpeechVoices(undefined, c.req.query("cwd")));
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to list voices" }, 400);
  }
});

app.get("/v1/models", (c) => {
  const config = getTextToSpeechConfig(c.req.query("cwd"));
  const providers = Object.entries(config.providers ?? {})
    .filter(([, provider]) => provider?.enabled !== false)
    .map(([id, provider]) => ({
      id: provider?.model ?? id,
      object: "model",
      created: 0,
      owned_by: id,
    }));
  return c.json({ object: "list", data: providers });
});

app.get("/api/profiles/:name", (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  const profile = getProfile(name, cwd);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  return c.json({ ...profile, name, path: getProfileConfigPath(name, cwd) });
});

app.get("/api/profiles/:name/resolved-config", (c) => {
  const name = c.req.param("name");
  const sessionId = c.req.query("sessionId");
  const active = sessionId ? getActiveSession(sessionId) : undefined;
  const cwd = active?.projectRoot ?? c.req.query("cwd");
  const profile = getProfile(name, cwd);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  const mcp = resolveMcpServers({
    cwd,
    profileName: name,
    profile,
    sessionServers: active?._configOverrides.mcpServers,
  });
  const sessionPolicy = active?._configOverrides.permissionPolicy;
  return c.json({
    mcpServers: mcp.servers,
    mcpOrigins: mcp.origins,
    permissionPolicy: sessionPolicy ?? profile.permissionPolicy ?? "bypass",
    permissionOrigin: sessionPolicy ? "session" : profile.permissionPolicy ? "profile" : "default",
  });
});

app.put("/api/profiles/:name", async (c) => {
  const name = c.req.param("name");
  const cwd = c.req.query("cwd");
  if (name.startsWith("_")) return c.json({ error: "reserved name" }, 400);
  if (getProfileConfig(name, cwd)?.origin === "plugin" || name.startsWith("plugin:")) {
    return c.json({ error: "plugin profiles are read-only merged content" }, 403);
  }
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
  if (profile.origin === "plugin") {
    return c.json({ error: "plugin profile UI is read-only merged content" }, 403);
  }
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
  // See /api/profiles: `ui=1` folds in the UI config the client would otherwise
  // request once per profile. Client extensions live in this payload, so the
  // extension surface could not resolve until that whole fan-out completed.
  const withUi = c.req.query("ui") === "1";
  const all = getAllUserProfiles();
  const list = Object.entries(all).map(([name, p]) => ({
    name,
    ...p,
    ...(withUi ? getUserProfileUiConfig(name) ?? {} : {}),
  }));
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

// —— Config Pages (.modus/pages/*.json) ——

app.get("/api/pages", (c) => {
  const cwd = c.req.query("cwd");
  return c.json(listConfigPages(cwd));
});

app.post("/api/pages/fork", async (c) => {
  const body = await c.req.json<{ cwd?: string; pageId?: string }>().catch(() => null);
  if (!body || !body.cwd || !body.pageId) {
    return c.json({ error: "cwd and pageId are required" }, 400);
  }
  const result = forkConfigPage(body.cwd, body.pageId);
  if (!result.ok) return c.json({ error: result.error }, 404);
  const project = getProjectByPath(body.cwd);
  if (project && result.path) {
    recordAttributionHint({ kind: "project", projectId: project.id }, result.path, { type: "human" });
  }
  return c.json({ ok: true, path: result.path });
});

// —— Docs (built-in documentation: index, content, batch search) ——
// Header-auth only — these routes are NOT in the query-credential allowlist.

function parseDocAudience(value: string | undefined): DocAudience | "all" | undefined {
  if (value === "user" || value === "dev" || value === "agent" || value === "all") return value;
  return undefined;
}

app.get("/api/docs", (c) => {
  return c.json(listDocs({
    audience: parseDocAudience(c.req.query("audience")),
    cwd: c.req.query("cwd"),
  }));
});

// Build identity and help content. One source for the about widget, the docs
// page, and user settings, so the three cannot drift apart.
app.get("/api/about", (c) => c.json(getAboutInfo()));

app.post("/api/docs/search", async (c) => {
  const body = await c.req.json<{
    queries?: unknown;
    limit?: unknown;
    audience?: string;
    cwd?: string;
  }>().catch(() => null);
  if (!body || !Array.isArray(body.queries) || body.queries.some((q) => typeof q !== "string")) {
    return c.json({ error: "queries must be an array of strings" }, 400);
  }
  const results = searchDocs(body.queries as string[], {
    limit: typeof body.limit === "number" ? body.limit : undefined,
    audience: parseDocAudience(body.audience),
    cwd: body.cwd,
  });
  return c.json({ results });
});

app.get("/api/docs/*", (c) => {
  const id = decodeURIComponent(c.req.path.slice("/api/docs/".length));
  const doc = getDoc(id, { cwd: c.req.query("cwd") });
  if (!doc) return c.json({ error: "doc not found" }, 404);
  return c.json(doc);
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

app.post("/api/providers/detect", async (c) => {
  const { detectLocalProviders } = await import("./providers/provider-detection");
  return c.json(await detectLocalProviders());
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

/** Resolve user profile scoping from query param.
 * Mirrors the UI visibility rules while retaining legacy, unqualified session
 * profile names: project profiles are always visible; manifest-integrated plugin
 * profiles are visible unless hidden; user profiles honor the whitelist. */
function resolveUserProfileScope(c: any): { projectId: string; cwdPrefixes?: string[]; agentProfiles?: string[] } | undefined {
  const profileName = new URL(c.req.url).searchParams.get("userProfile");
  if (!profileName) return undefined;
  const profile = getUserProfile(profileName);
  if (!profile) return undefined;

  let agentProfiles: string[] | undefined;
  if (profile.agentProfiles?.length) {
    const allowed = new Set(profile.agentProfiles);
    const hiddenPluginProfiles = new Set(profile.hiddenPluginProfiles ?? []);
    for (const proj of profile.projects ?? []) {
      const merged = getAllProfiles(proj);
      for (const [key, candidate] of Object.entries(merged)) {
        const displayName = candidate.displayName ?? key;
        if (candidate.origin === "project") {
          allowed.add(key);
          allowed.add(displayName);
        } else if (candidate.origin === "plugin" && !hiddenPluginProfiles.has(key)) {
          allowed.add(key);
          allowed.add(displayName);
        } else if (
          candidate.origin === "user"
          && (allowed.has(key) || allowed.has(displayName))
        ) {
          allowed.add(key);
          allowed.add(displayName);
        }
      }
    }
    agentProfiles = Array.from(allowed);
  }

  return {
    projectId: profileName,
    cwdPrefixes: profile.projects?.length ? profile.projects : undefined,
    agentProfiles,
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

function configuredSessionProjects(): SessionProjectDescriptor[] {
  return buildProjectDescriptors(getAllUserProfiles());
}

function enrichSessionRows(rows: ReturnType<typeof listSessions>, projects = configuredSessionProjects()) {
  return rows.map((session) => {
    const active = getActiveSession(session.id);
    const storedConfig = session.provider ? null : getStoredSessionConfig(session.id);
    const provider = active?.provider ?? session.provider ?? storedConfig?.provider ?? null;
    const isEmptyIdlePlaceholder = session.status === "idle"
      && (session.message_count ?? 0) === 0
      && !session.preview
      && !session.last_prompt
      && !session.last_response;
    const staleLiveStatus = session.status === "running"
      || session.status === "starting"
      || session.status === "paused"
      || session.status === "interrupting";
    const status = active?.status
      ?? (isEmptyIdlePlaceholder ? "idle" : staleLiveStatus ? "done" : session.status);
    const project = resolveSessionProject(session, projects);

    return {
      ...session,
      provider,
      status,
      updated_at: active ? Math.max(session.updated_at, active.lastEventAt) : session.updated_at,
      total_cost_usd: active?.costUsd ?? session.total_cost_usd,
      project_id: project.projectId,
      project_name: project.projectName,
      project_root: project.projectRoot,
      project_explicit: project.explicit,
      live_text: (active?.liveStream.text || active?.lastAssistantText || "").slice(-320) || null,
      live_seq: active?.seq ?? null,
      last_event_at: active?.lastEventAt ?? null,
      last_input_tokens: null,
      last_output_tokens: null,
      pending_permission_count: active?.pendingPermissions.size ?? 0,
    };
  });
}

app.get("/api/sessions/index", (c) => {
  const requested = Number(new URL(c.req.url).searchParams.get("limit") ?? 250);
  const limit = Number.isFinite(requested) ? Math.min(1000, Math.max(1, Math.floor(requested))) : 250;
  const configured = configuredSessionProjects();
  const sessions = enrichSessionRows(listSessions(limit), configured);
  const projects = configured.map((project) => {
    const rows = sessions.filter((session) => session.project_id === project.id);
    return {
      id: project.id,
      name: project.name,
      roots: project.roots,
      session_count: rows.length,
      active_count: rows.filter((session) => (
        session.status === "running"
        || session.status === "starting"
        || session.status === "interrupting"
        || session.status === "paused"
      )).length,
      // Conversation time, matching the session list's own ordering key — a row
      // write (rename, pin, reap notice) must not report project activity.
      last_activity_at: rows.length > 0
        ? Math.max(...rows.map((session) => session.last_message_at || session.created_at || session.updated_at))
        : null,
    };
  });
  return c.json({ generated_at: Date.now(), projects, sessions });
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
  return c.json(enrichSessionRows(rows));
});

app.get("/api/sessions/active", (c) => {
  const scope = resolveUserProfileScope(c);
  const projects = configuredSessionProjects();
  const memSessions = getAllActiveSessions().map((s) => {
    const dbRow = getSession(s.sessionId);
    const project = resolveSessionProject({ user_profile: s.userProfile ?? dbRow?.user_profile, cwd: s.cwd }, projects);
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
      lastText: s.liveStream.text || s.lastAssistantText || null,
      seq: s.seq,
      subscribers: s.subscribers.size,
      cwd: s.cwd ?? null,
      additionalDirectories: s.additionalDirectories.length > 0 ? s.additionalDirectories : null,
      project_id: project.projectId,
      project_name: project.projectName,
      project_root: project.projectRoot,
      archived: dbRow?.archived === 1,
    };
  });
  // Apply user profile scoping server-side
  const filtered = scope
    ? memSessions.filter((session) => session.project_id === scope.projectId)
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
    permissionPolicy: body.permissionPolicy,
    loadProjectSettings: body.loadProjectSettings,
    mcpServers: body.mcpServers,
    sessionId: body.sessionId, // for resume
    moves: body.moves,
    skipProfileMoves: body.skipProfileMoves,
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
  const permissionPolicy = body.permissionPolicy
    ?? (body.permissionMode === "bypass" ? "bypass" as const : undefined);

  // Validate profile if provided
  if (body.profile && !getProfile(body.profile, resolvedCwd)) {
    return c.json(
      { error: `unknown profile: ${body.profile}`, available: listProfileNames(resolvedCwd) },
      400,
    );
  }

  let targetSessionId: string | undefined = sessionId;
  try {
    const result = await interactWithSession({
      prompt,
      sessionId,
      attachments,
      moves,
      createIfMissing,
      cwd: body.cwd ?? resolvedCwd,
      additionalDirectories: body.additionalDirectories,
      profile: body.profile,
      userProfile: body.userProfile,
      provider: body.provider,
      model: body.model,
      toolStates: body.toolStates,
      maxTurns: body.maxTurns,
      effort: body.effort,
      tools: body.tools,
      disallowedTools: body.disallowedTools,
      providerControls: body.providerControls,
      loadProjectSettings: body.loadProjectSettings,
      permissionPolicy,
      mcpServers: body.mcpServers,
    });
    targetSessionId = result.sessionId;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (sessionId && message === `session not found: ${sessionId}`) {
      return c.json({ error: message }, 404);
    }
    if (!sessionId && !createIfMissing && message === "sessionId required when createIfMissing is false") {
      return c.json({ error: message }, 400);
    }
    const status = message.includes("[memory-guard]") ? 503 : 500;
    return c.json({ error: message }, status);
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

// ── SSE direct-stream helpers ──
// Bypasses Hono's streamSSE (which uses TransformStream — buffered by Bun on Windows).
// Uses Bun's `type: "direct"` ReadableStream with explicit flush() after each write,
// ensuring events reach the client immediately on all platforms.

function formatSSE(event: string, data: string, id: string): string {
  let msg = "";
  if (event) msg += `event: ${event}\n`;
  if (id) msg += `id: ${id}\n`;
  msg += `data: ${data}\n\n`;
  return msg;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Transfer-Encoding": "chunked",
} as const;

/**
 * Create an SSE Response using Bun's direct ReadableStream.
 * The handler receives a writer with auto-flushing write() and a cleanup signal.
 * When the handler's returned promise resolves, the stream closes.
 */
function sseResponse(
  req: Request,
  handler: (
    writer: { write(event: string, data: string, id: string): Promise<void> },
    signal: AbortSignal,
  ) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    type: "direct" as any,
    async pull(controller: any) {
      const writer = {
        async write(event: string, data: string, id: string) {
          controller.write(encoder.encode(formatSSE(event, data, id)));
          await controller.flush();
        },
      };
      try {
        await handler(writer, req.signal);
      } catch (err) {
        if ((err as any)?.name !== "AbortError") {
          console.error("[sse] stream handler error:", err);
        }
      } finally {
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

// ── Shared SSE streaming helper ──
// Used by both GET /api/sessions/:id/events and POST /api/sessions/interact
function streamSessionSSE(c: any, sessionId: string, afterSeq = 0) {
  return sseResponse(c.req.raw, async (writer, signal) => {
    // Send catch-up events from DB, bookended by catchup-start/catchup-end
    // so the client can batch them into a single React render.
    const _sseT0 = performance.now();
    const pastEvents = getEvents(sessionId, afterSeq);
    const _sseT1 = performance.now();
    if (pastEvents.length > 0) {
      await writer.write("catchup-start", "{}", "");
      for (const evt of pastEvents) {
        let data = evt.data;
        try { data = JSON.stringify({ ...JSON.parse(evt.data), _ts: evt.created_at }); } catch {}
        await writer.write(evt.type, data, String(evt.seq));
      }
      await writer.write("catchup-end", "{}", "");
    }
    const _sseT2 = performance.now();
    console.log(`[TIMING] SSE catch-up session=${sessionId.slice(0,8)} query=${(_sseT1-_sseT0).toFixed(1)}ms serialize+send=${(_sseT2-_sseT1).toFixed(1)}ms events=${pastEvents.length}`);

    // Check if catch-up already included a "done" event (persisted by emitEvent).
    // If the session is finished but the replay didn't include "done" (legacy sessions),
    // we'll synthesize one below to prevent the client entering a reconnect loop.
    const catchupHadDone = pastEvents.some((e) => e.type === "done");

    // If session is active, subscribe for live events.
    // "done" sessions stay in the active map and may receive follow-up messages
    // (via queueMessage → _queueMessageAsync). We give them a grace period so the
    // SSE stream stays open long enough for the async message pipeline to set
    // status back to "running" and start emitting events.
    const catchupLastSeq = pastEvents.length > 0
      ? pastEvents[pastEvents.length - 1]!.seq
      : afterSeq;

    const active = getActiveSession(sessionId);
    if (active && active.status !== "error") {
      if (
        active.liveStream.seq > catchupLastSeq
        && (active.liveStream.text || active.liveStream.thinking || active.liveStream.feed)
      ) {
        await writer.write("system", JSON.stringify({
          type: "system",
          subtype: "live_snapshot",
          text: active.liveStream.text,
          thinking: active.liveStream.thinking,
          feed: active.liveStream.feed,
        }), String(active.liveStream.seq));
      }

      let resolve: () => void;
      const done = new Promise<void>((r) => { resolve = r; });
      const unregisterBrowser = registerBrowserConnection(c, () => resolve(), true);

      const keepAlive = setInterval(async () => {
        try { await writer.write("ping", "{}", ""); } catch { /* connection dead */ }
      }, 30_000);

      // Grace timeout for "done" sessions: if no real events arrive within 5s,
      // close the stream. Prevents idle connections for genuinely finished sessions
      // while giving the async message pipeline time to reactivate the session.
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      if (active.status === "done" && active.dispatchState !== "dispatching_followup") {
        if (catchupHadDone) {
          // Client already received the persisted "done" event during catch-up.
          // No need to keep the stream open — close immediately.
          resolve!();
        } else {
          graceTimer = setTimeout(async () => {
            // Grace period expired — session is genuinely done but client never
            // received the "done" event (e.g. it wasn't persisted in older sessions).
            // Send a synthetic done so the client fires onDone, not onDisconnect.
            try { await writer.write("done", "{}", "done"); } catch { /* connection dead */ }
            resolve();
          }, 5_000);
        }
      }

      const sseWriter: SSEWriter = {
        async write(event: string, data: string, seqId: string) {
          // A real event arrived — cancel any pending grace close. If this
          // event is "done" we'll re-arm grace below; otherwise the session
          // is producing again and the stream stays open.
          if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
          const t0 = Date.now();
          await writer.write(event, data, seqId);
          const dt = Date.now() - t0;
          if (dt > 50) console.log(`[sse] slow write: ${event} took ${dt}ms (session=${sessionId})`);
          if (event === "done") {
            // "done" ends a turn, not necessarily the session: a queued
            // message, action retry or mission cycle can re-activate the same
            // session moments later. Closing here would drop every following
            // broadcast until the client reconnected, so the stream is held
            // open for a grace window instead. Any real event arriving first
            // cancels it via the clearTimeout above and streaming continues.
            graceTimer = setTimeout(() => { resolve(); }, 5_000);
          }
        },
        close() { resolve(); },
      };

      const unsubscribe = subscribe(sessionId, sseWriter);

      // Handle client disconnect via request abort signal
      const onAbort = () => {
        if (graceTimer) clearTimeout(graceTimer);
        clearInterval(keepAlive);
        unsubscribe();
        resolve();
      };
      signal.addEventListener("abort", onAbort);

      await done;
      signal.removeEventListener("abort", onAbort);
      if (graceTimer) clearTimeout(graceTimer);
      clearInterval(keepAlive);
      unsubscribe();
      unregisterBrowser();
    } else if (!catchupHadDone) {
      // Session is not active — send synthetic done so client doesn't hang
      await writer.write("done", "{}", "done");
    }
  });
}

// ── SSE buffering diagnostic endpoint ──
// Sends 10 events at 1-second intervals. If the browser receives them all at once
// after 10s instead of one-by-one, Bun is buffering HTTP responses on this platform.
app.get("/api/test-sse", (c) => {
  return sseResponse(c.req.raw, async (writer) => {
    for (let i = 0; i < 10; i++) {
      const ts = Date.now();
      console.log(`[test-sse] sending event ${i} at ${ts}`);
      await writer.write("test", JSON.stringify({ i, ts }), String(i));
      console.log(`[test-sse] sent event ${i}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    await writer.write("done", "{}", "done");
  });
});

// Subscribe to session events (SSE)
app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  const afterSeq = Number(new URL(c.req.url).searchParams.get("after") ?? 0);
  return streamSessionSSE(c, id, afterSeq);
});

// ── Multiplexed session events (SSE) ──
// One connection carries catch-up + live events for MANY sessions, each tagged
// with its session id. Replaces the one-stream-per-session model so the
// browser's ~6-connection HTTP/1.1 cap can't be exhausted when many agents run.
//
// Wire format (all events carry their session id in the data envelope):
//   event: catchup-start  data: {"sid":"..."}
//   event: ev             data: {"sid":"...","seq":N,"ev":{...}}
//   event: catchup-end    data: {"sid":"..."}
//   event: done           data: {"sid":"..."}      (no live events coming for sid)
//   event: ping           data: {}
type MultiSpec = { id: string; after: number };

function streamMultiSessionSSE(c: any, specs: MultiSpec[]) {
  return sseResponse(c.req.raw, async (writer, signal) => {
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const unregisterBrowser = registerBrowserConnection(c, () => resolve(), true);
    // Serialize every write through one chain. Catch-up writes and live
    // broadcast writes from independent sessions both target the same
    // controller; without this, their byte chunks could interleave and corrupt
    // the SSE framing.
    let writeChain: Promise<void> = Promise.resolve();
    let pendingWrites = 0;
    const MAX_PENDING_WRITES = 256;
    const send = (event: string, obj: unknown): Promise<void> => {
      if (pendingWrites >= MAX_PENDING_WRITES) {
        console.warn(`[sse-multi] closing slow client with ${pendingWrites} queued writes`);
        resolve();
        return Promise.resolve();
      }
      pendingWrites++;
      writeChain = writeChain
        .then(() => writer.write(event, JSON.stringify(obj), ""))
        .catch(() => { resolve(); })
        .finally(() => { pendingWrites--; });
      return writeChain;
    };

    const keepAlive = setInterval(() => { void send("ping", {}); }, 30_000);
    const unsubscribers: Array<() => void> = [];

    for (const spec of specs) {
      const sessionId = spec.id;
      const afterSeq = Number.isFinite(spec.after) ? spec.after : 0;

      // Catch-up from DB, bracketed per session so the client batch-renders it.
      const pastEvents = getEvents(sessionId, afterSeq);
      if (pastEvents.length > 0) {
        await send("catchup-start", { sid: sessionId });
        for (const evt of pastEvents) {
          let data: any = null;
          try { data = { ...JSON.parse(evt.data), _ts: evt.created_at }; } catch { /* skip malformed */ }
          if (data) await send("ev", { sid: sessionId, seq: evt.seq, ev: data });
        }
        await send("catchup-end", { sid: sessionId });
      }
      const catchupLastSeq = pastEvents.length > 0 ? pastEvents[pastEvents.length - 1]!.seq : afterSeq;

      const active = getActiveSession(sessionId);
      if (active && active.status !== "error") {
        // Restore in-flight streaming text/thinking not yet persisted.
        if (
          active.liveStream.seq > catchupLastSeq
          && (active.liveStream.text || active.liveStream.thinking || active.liveStream.feed)
        ) {
          await send("ev", {
            sid: sessionId,
            seq: active.liveStream.seq,
            ev: {
              type: "system",
              subtype: "live_snapshot",
              text: active.liveStream.text,
              thinking: active.liveStream.thinking,
              feed: active.liveStream.feed,
            },
          });
        }
        // Live subscription — forward each broadcast event tagged with sid.
        const sseWriter: SSEWriter = {
          write(event: string, data: string, seqId: string) {
            if (event === "done") return send("done", { sid: sessionId });
            let ev: any;
            try { ev = JSON.parse(data); } catch { return Promise.resolve(); }
            return send("ev", { sid: sessionId, seq: Number(seqId) || 0, ev });
          },
          close() { /* per-session close is a no-op; the shared stream lives on */ },
        };
        unsubscribers.push(subscribe(sessionId, sseWriter));
      } else {
        // Settled / unknown session — tell the client no live events are coming
        // for this sid so it can clear its catching-up state.
        await send("done", { sid: sessionId });
      }
    }

    const onAbort = () => {
      clearInterval(keepAlive);
      for (const unsub of unsubscribers) unsub();
      resolve();
    };
    signal.addEventListener("abort", onAbort);

    await done;
    signal.removeEventListener("abort", onAbort);
    clearInterval(keepAlive);
    for (const unsub of unsubscribers) unsub();
    unregisterBrowser();
  });
}

app.get("/api/events/multi", (c) => {
  const raw = new URL(c.req.url).searchParams.get("sessions") ?? "[]";
  let specs: MultiSpec[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      specs = parsed
        .filter((s) => s && typeof s.i === "string")
        .map((s) => ({ id: s.i as string, after: Number(s.s) || 0 }));
    }
  } catch { /* malformed spec — empty stream, client will retry */ }
  return streamMultiSessionSSE(c, specs);
});

// POST avoids URL-length limits when many sessions are subscribed and keeps
// bearer credentials in headers rather than query-string logs/history.
app.post("/api/events/multi", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { sessions?: unknown };
  const specs: MultiSpec[] = Array.isArray(body.sessions)
    ? body.sessions
      .filter((spec: any) => spec && typeof spec.i === "string")
      .map((spec: any) => ({ id: spec.i, after: Number(spec.s) || 0 }))
    : [];
  return streamMultiSessionSSE(c, specs);
});

// Global session lifecycle events (SSE) — used by SessionWeb for real-time updates
app.get("/api/events/sessions", (c) => {
  return sseResponse(c.req.raw, async (writer, signal) => {
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const unregisterBrowser = registerBrowserConnection(c, () => resolve(), true);

    const keepAlive = setInterval(async () => {
      try { await writer.write("ping", "{}", ""); } catch { /* dead */ }
    }, 30_000);

    const globalWriter = {
      async write(data: string) {
        await writer.write("session", data, String(Date.now()));
      },
      close() { resolve(); },
    };

    const unsubscribe = subscribeGlobal(globalWriter);
    const onAbort = () => { clearInterval(keepAlive); unsubscribe(); resolve(); };
    signal.addEventListener("abort", onAbort);

    await done;
    signal.removeEventListener("abort", onAbort);
    clearInterval(keepAlive);
    unsubscribe();
    unregisterBrowser();
  });
});

// ── Filesystem change events (SSE) — used by FileBrowser and FileViewer for live refresh ──
app.get("/api/events/fs", (c) => {
  // Optional: start watching a specific root (defaults to whatever is already being watched)
  const watchPath = new URL(c.req.url).searchParams.get("root");
  if (watchPath) startWatching(watchPath);

  return sseResponse(c.req.raw, async (sseWriter, signal) => {
    let resolve: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    const unregisterBrowser = registerBrowserConnection(c, () => resolve(), true);

    const keepAlive = setInterval(async () => {
      try { await sseWriter.write("ping", "{}", ""); } catch { /* dead */ }
    }, 30_000);

    const unsub = subscribeFsEvents({
      write(event: FsChangeEvent) {
        sseWriter.write("fs", JSON.stringify(event), String(Date.now())).catch(() => {});
      },
      close() { resolve(); },
    });

    const onAbort = () => { clearInterval(keepAlive); unsub(); resolve(); };
    signal.addEventListener("abort", onAbort);

    await done;
    signal.removeEventListener("abort", onAbort);
    clearInterval(keepAlive);
    unsub();
    unregisterBrowser();
  });
});

// Get reconstructed message content for a session (from events)
app.get("/api/sessions/:id/messages-content", (c) => {
  const id = c.req.param("id");
  const seq = c.req.query("seq");
  if (seq) {
    const seqNum = Number(seq);
    if (!Number.isFinite(seqNum) || seqNum <= 0) return c.json({ error: "invalid message sequence" }, 400);
    const msg = getSessionMessage(id, seqNum);
    if (!msg) return c.json({ error: "message not found" }, 404);
    return c.json(msg);
  }
  return c.json(getSessionMessages(id));
});

// Every turn in a session with no bodies — what a turn-navigating surface needs
// to know the shape of a conversation without paging the whole transcript in.
app.get("/api/sessions/:id/turns", (c) => {
  const id = c.req.param("id");
  if (!getSession(id) && !getActiveSession(id)) return c.json({ error: "session not found" }, 404);
  const requestedLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(5000, Math.floor(requestedLimit))
    : undefined;
  return c.json(getSessionTurnIndex(id, limit != null ? { limit } : {}));
});

app.get("/api/sessions/:id/history-snapshot", (c) => {
  const id = c.req.param("id");
  const rawLimit = c.req.query("limit");
  const requestedLimit = Number(rawLimit ?? 40);
  const limit = rawLimit === "all"
    ? undefined
    : Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, Math.floor(requestedLimit)))
      : 40;
  const requestedBeforeSeq = Number(c.req.query("beforeSeq"));
  const beforeSeq = Number.isFinite(requestedBeforeSeq) && requestedBeforeSeq > 0
    ? Math.floor(requestedBeforeSeq)
    : undefined;
  const requestedBeforeCreatedAt = Number(c.req.query("beforeCreatedAt"));
  const beforeCreatedAt = Number.isFinite(requestedBeforeCreatedAt) && requestedBeforeCreatedAt > 0
    ? Math.floor(requestedBeforeCreatedAt)
    : undefined;
  const requestedBeforeId = Number(c.req.query("beforeId"));
  const beforeId = Number.isFinite(requestedBeforeId) && requestedBeforeId > 0
    ? Math.floor(requestedBeforeId)
    : undefined;
  const row = getSession(id);
  const active = getActiveSession(id);
  if (!row && !active) return c.json({ error: "session not found" }, 404);

  const storedConfig = getStoredSessionConfig(id);
  const agentConfig = {
    toolStates: storedConfig?.toolStates ?? {},
    model: storedConfig?.model ?? row?.model ?? active?.model ?? "",
    provider: storedConfig?.provider ?? row?.provider ?? active?.provider ?? "",
    effort: storedConfig?.effort ?? "",
    maxTurns: typeof storedConfig?.maxTurns === "number" ? String(storedConfig.maxTurns) : "",
    permissionPolicy: active?._configOverrides.permissionPolicy ?? storedConfig?.permissionPolicy,
    providerControls: storedConfig?.providerControls ?? {},
  };

  const status = active?.status
    ?? (row && !getActiveSession(id) && (row.status === "running" || row.status === "starting" || row.status === "idle" || row.status === "paused")
      ? "done"
      : row?.status
    )
    ?? "done";
  const history = getSessionMessageHistory(id, {
    limit,
    beforeSeq,
    beforeCreatedAt,
    beforeId,
    includeDetails: c.req.query("details") !== "summary",
    preserveEventSequence: true,
  });

  return c.json({
    sessionId: id,
    status,
    model: row?.model ?? active?.model ?? storedConfig?.model ?? "",
    cwd: row?.cwd ?? active?.cwd ?? storedConfig?.cwd ?? "",
    additionalDirectories: active?.additionalDirectories ?? storedConfig?.additionalDirectories ?? [],
    loadProjectSettings: active?._configOverrides.loadProjectSettings ?? storedConfig?.loadProjectSettings ?? true,
    agentConfig,
    messages: history.messages,
    recoveredFromEvents: history.recoveredFromEvents,
    hasMoreHistory: history.hasMore,
    oldestSeq: history.oldestSeq,
    oldestCreatedAt: history.oldestCreatedAt,
    oldestId: history.oldestId,
    olderTurnCount: history.olderTurnCount,
    lastSeq: active?.seq ?? getMaxSeq(id),
    createdAt: row?.created_at ?? active?.startedAt ?? Date.now(),
  });
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
  try {
    const delivered = await interactWithSession({
      sessionId: id,
      prompt,
      attachments: body.attachments,
      moves: body.moves,
      createIfMissing: false,
      cwd: body.cwd,
      additionalDirectories: body.additionalDirectories,
      profile: body.profile,
      userProfile: body.userProfile,
      provider: body.provider,
      model: body.model,
      effort: body.effort,
      maxTurns: body.maxTurns,
      tools: body.tools,
      disallowedTools: body.disallowedTools,
      toolStates: body.toolStates,
      providerControls: body.providerControls,
      loadProjectSettings: body.loadProjectSettings,
    });
    return c.json(delivered);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("[memory-guard]") ? 503 : 500;
    return c.json({ error: message }, status);
  }
});

app.delete("/api/sessions/:id/dispatch/:dispatchId", (c) => {
  const ok = cancelQueuedDispatch(c.req.param("id"), c.req.param("dispatchId"));
  return c.json({ ok });
});

// Steer: inject a message at the next tool boundary. `mode` reports what actually
// happened — "steer" reached the running turn, "queued" is waiting for it to end.
app.post("/api/sessions/:id/steer", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return c.json({ error: "prompt required" }, 400);
  const result = await steerMessage(id, prompt, body.attachments, body.moves);
  if (result.mode === "none") return c.json({ error: "session not found" }, 404);
  return c.json(result);
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

// Branch session — fork from a specific point in a past conversation.
// restoreCode: also rewind the working tree to the checkpoint for that message.
app.post("/api/sessions/:id/branch/preview", async (c) => {
  const sourceId = c.req.param("id");
  const body = await c.req.json();
  const { seq, restoreCode, checkpointSeq, providerMessageId } = body;
  if (!Number.isInteger(seq) || seq < 1) return c.json({ error: "seq required (positive integer)" }, 400);
  const result = await previewSessionBranch(sourceId, seq, {
    restoreCode: restoreCode === true,
    checkpointSeq: Number.isInteger(checkpointSeq) ? checkpointSeq : undefined,
    providerMessageId: typeof providerMessageId === "string" ? providerMessageId : undefined,
  });
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

app.post("/api/sessions/:id/branch", async (c) => {
  const sourceId = c.req.param("id");
  const body = await c.req.json();
  const { seq, restoreCode, checkpointSeq, providerMessageId, confirmed } = body;
  if (!Number.isInteger(seq) || seq < 1) return c.json({ error: "seq required (positive integer)" }, 400);
  const result = await branchSession(sourceId, seq, {
    restoreCode: restoreCode === true,
    checkpointSeq: Number.isInteger(checkpointSeq) ? checkpointSeq : undefined,
    providerMessageId: typeof providerMessageId === "string" ? providerMessageId : undefined,
    confirmed: confirmed === true,
  });
  if ("error" in result) return c.json({ error: result.error }, 400);
  return c.json(result);
});

app.get("/api/sessions/:id/checkpoints/:checkpointId/preview", async (c) => {
  const checkpointId = Number(c.req.param("checkpointId"));
  if (!Number.isInteger(checkpointId) || checkpointId < 1) return c.json({ error: "valid checkpoint id required" }, 400);
  const result = await previewSessionCheckpoint(c.req.param("id"), checkpointId);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
});

app.get("/api/sessions/:id/file-observations", (c) => {
  return c.json({
    observations: getFileObservations(c.req.param("id")),
    authority: "observability-only",
    warning: "Provider-declared tool paths are provenance hints, not proof of every workspace change and never authorize undo.",
  });
});

app.post("/api/sessions/:id/checkpoints/:checkpointId/restore", async (c) => {
  const checkpointId = Number(c.req.param("checkpointId"));
  if (!Number.isInteger(checkpointId) || checkpointId < 1) return c.json({ error: "valid checkpoint id required" }, 400);
  const body = await c.req.json();
  const result = await restoreSessionCheckpoint(c.req.param("id"), checkpointId, body.confirmed === true);
  if ("error" in result) return c.json(result, 400);
  return c.json(result);
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

// ── Pinboards ──
// Project-scoped pin groups stored in .modus/state/pinboards.json

app.get("/api/pinboards", async (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ groups: [], activeGroupId: null });
  const { join } = await import("path");
  const { readFile } = await import("fs/promises");
  try {
    const raw = await readFile(join(cwd, ".modus", "state", "pinboards.json"), "utf-8");
    return c.json(JSON.parse(raw));
  } catch {
    return c.json({ groups: [], activeGroupId: null });
  }
});

app.put("/api/pinboards", async (c) => {
  const cwd = c.req.query("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const { join } = await import("path");
  const { writeFile, mkdir } = await import("fs/promises");
  const body = await c.req.json();
  const dir = join(cwd, ".modus", "state");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pinboards.json"), JSON.stringify(body, null, 2), "utf-8");
  return c.json(body);
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

app.get("/api/files/search", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const root = params.get("root");
  const query = params.get("q")?.trim() ?? "";
  const limit = Math.max(1, Math.min(200, Number(params.get("limit") ?? 50) || 50));

  if (!root) return c.json({ error: "root required" }, 400);
  if (!query) return c.json({ available: true, provider: "none", results: [] });

  const targetRoot = resolve(root);

  try {
    const { stat } = await import("fs/promises");
    const info = await stat(targetRoot);
    if (!info.isDirectory()) return c.json({ error: "root must be a directory" }, 400);
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "root not found" : err.message }, 400);
  }

  return c.json(await searchFilesWithEverything(targetRoot, query, limit));
});

// ── File Reader ──
// Read a single file's text content by absolute path.
app.get("/api/preview/manifest", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const params = new URL(c.req.url).searchParams;
  const raw = params.get("path");
  if (!raw) return c.json({ error: "path required" }, 400);
  const target = resolve(raw);
  const roots = previewRoots(params);
  const denied = assertPreviewAllowed(target, roots);
  if (denied) return c.json({ error: denied }, 403);
  try {
    const scope = new URLSearchParams();
    for (const key of ["cwd", "sessionId", "userProfile"]) {
      const value = params.get(key);
      if (value) scope.set(key, value);
    }
    return c.json(await buildPreviewManifest(target, roots, scope.toString()));
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "not found" : err.message }, 404);
  }
});

app.get("/api/preview/file/:id", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const target = pathFromPreviewId(c.req.param("id"));
  if (!target) return c.json({ error: "invalid preview id" }, 400);
  const params = new URL(c.req.url).searchParams;
  const roots = previewRoots(params);
  const denied = assertPreviewAllowed(target, roots);
  if (denied) return c.json({ error: denied }, 403);
  const file = Bun.file(target);
  if (!(await file.exists())) return c.json({ error: "not found" }, 404);
  const info = previewInfoForPath(target, false);
  const size = file.size;
  const rangeHeader = c.req.header("Range");
  const baseHeaders = {
    "Content-Type": info.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; script-src 'none'; frame-ancestors 'self'",
  };

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Math.max(0, Number(match[1]));
      const end = Math.min(match[2] ? Number(match[2]) : size - 1, size - 1);
      if (start <= end) {
        const chunk = file.slice(start, end + 1);
        return new Response(chunk, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Length": String(end - start + 1),
            "Content-Range": `bytes ${start}-${end}/${size}`,
          },
        });
      }
    }
  }

  return new Response(file, {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
});

app.get("/api/artifact-shelf", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const params = new URL(c.req.url).searchParams;
  const roots = previewRoots(params);
  const cwd = params.get("cwd") ? resolve(params.get("cwd")!) : roots[0] ?? null;
  const limit = Math.max(1, Math.min(100, Number(params.get("limit") ?? 40) || 40));
  if (!cwd || assertPreviewAllowed(cwd, roots)) return c.json({ cwd: null, items: [] });

  const { readdir, stat } = await import("fs/promises");
  const candidates = ["dist", "build", "out", "public", "exports", ".modus/artifacts"].map((rel) => join(cwd, rel));
  const items: any[] = [];
  const seen = new Set<string>();
  async function scan(dir: string, depth: number) {
    if (items.length >= limit || depth > 4 || assertPreviewAllowed(dir, roots)) return;
    let entries: any[];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (items.length >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(p, depth + 1);
        continue;
      }
      if (!entry.isFile() || seen.has(p)) continue;
      const info = previewInfoForPath(p);
      if (!["html", "image", "audio", "video", "pdf"].includes(info.kind)) continue;
      try {
        const s = await stat(p);
        seen.add(p);
        const scope = new URLSearchParams();
        if (cwd) scope.set("cwd", cwd);
        const manifest = await buildPreviewManifest(p, roots, scope.toString());
        items.push({ ...manifest, source: "recent", modifiedAt: s.mtimeMs });
      } catch { /* skip vanished file */ }
    }
  }
  for (const dir of candidates) await scan(dir, 0);
  items.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  return c.json({ cwd, items: items.slice(0, limit) });
});

app.get("/api/file-read", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
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
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
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
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const { path: rawPath, content } = await c.req.json<{ path: string; content: string }>();
  if (!rawPath || typeof content !== "string") {
    return c.json({ error: "path and content required", code: "rejected" }, 400);
  }
  const { resolve } = await import("path");
  const { writeFile } = await import("fs/promises");
  const target = resolve(rawPath);
  try {
    await writeFile(target, content, "utf-8");
  } catch (err) {
    const failure = fileMutationFailure(err, target);
    return c.json({ error: failure.error, code: failure.code }, failure.status);
  }
  return c.json({ ok: true, path: target });
});

app.post("/api/file-create", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const { path: rawPath, content } = await c.req.json<{ path: string; content?: string }>();
  if (!rawPath) return c.json({ error: "path required", code: "rejected" }, 400);
  const { resolve, dirname } = await import("path");
  const { writeFile, mkdir, stat } = await import("fs/promises");
  const target = resolve(rawPath);
  try { await stat(target); return c.json({ error: "already exists", code: "collision" }, 409); } catch { /* ok */ }
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content ?? "", "utf-8");
  } catch (err) {
    const failure = fileMutationFailure(err, target);
    return c.json({ error: failure.error, code: failure.code }, failure.status);
  }
  return c.json({ ok: true, path: target });
});

app.post("/api/dir-create", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const { path: rawPath } = await c.req.json<{ path: string }>();
  if (!rawPath) return c.json({ error: "path required", code: "rejected" }, 400);
  const { resolve } = await import("path");
  const { mkdir, stat } = await import("fs/promises");
  const target = resolve(rawPath);
  try { await stat(target); return c.json({ error: "already exists", code: "collision" }, 409); } catch { /* ok */ }
  try {
    await mkdir(target, { recursive: true });
  } catch (err) {
    const failure = fileMutationFailure(err, target);
    return c.json({ error: failure.error, code: failure.code }, failure.status);
  }
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

// ── Workspace History ──

function historyScope(c: any): ShadowScope {
  const pid = c.req.param("pid");
  return pid ? { kind: "project", projectId: pid } : { kind: "user" };
}


// Changes (filtered list)
const historyChangesHandler = async (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) {
    const records = await listCommits(scope, {
      limit: Number(c.req.query("limit") ?? 50),
      since: c.req.query("since") ?? undefined,
      until: c.req.query("until") ?? undefined,
    });
    return c.json(records);
  }
  return c.json(queryChanges(db, {
    limit: Number(c.req.query("limit") ?? 50),
    since: c.req.query("since") ?? undefined,
    until: c.req.query("until") ?? undefined,
    kind: c.req.query("kind") ?? undefined,
    entity: c.req.query("entity") ?? undefined,
    actor: c.req.query("actor") ?? undefined,
  }));
};
app.get("/api/projects/:pid/history/changes", historyChangesHandler);
app.get("/api/user/history/changes", historyChangesHandler);

// Change detail (single commit with diffs)
const historyChangeDetailHandler = async (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const cid = c.req.param("cid");
  const record = getChange(db, cid);
  if (!record) return c.json({ error: "change not found" }, 404);

  const diffs = [];
  const files = await gitDiffTree(scope, cid);
  const workTree = getWorkTree(scope);
  const resolver = scope.kind === "project" ? projectEntities : userEntities;

  for (const entity of record.entities) {
    const relevantFiles = files.filter((f) => {
      const refs = resolver(join(workTree, f.path), workTree);
      return refs.some((r) => r.kind === entity.kind && r.id === entity.id);
    });

    let fromContent: string | null = null;
    let toContent: string | null = null;
    for (const file of relevantFiles) {
      const cur = file.op !== "D" ? await gitShowFile(scope, cid, file.path) : null;
      const prev = file.op !== "A" ? await gitShowFile(scope, `${cid}~1`, file.path) : null;
      fromContent = fromContent ? fromContent + "\n" + (prev ?? "") : prev;
      toContent = toContent ? toContent + "\n" + (cur ?? "") : cur;
    }

    diffs.push(entityDiff(entity, fromContent, toContent));
  }

  return c.json({ ...record, diffs });
};
app.get("/api/projects/:pid/history/changes/:cid", historyChangeDetailHandler);
app.get("/api/user/history/changes/:cid", historyChangeDetailHandler);

// Entity listing (all entities at a point in time)
const historyEntitiesHandler = (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const at = c.req.query("at") ?? undefined;
  return c.json(listEntityStates(db, at));
};
app.get("/api/projects/:pid/history/entities", historyEntitiesHandler);
app.get("/api/user/history/entities", historyEntitiesHandler);

// Single entity state
const historyEntityStateHandler = (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const at = c.req.query("at") ?? undefined;
  const state = getEntityState(db, kind, id, at);
  if (!state) return c.json({ error: "entity not found" }, 404);
  return c.json(state);
};
app.get("/api/projects/:pid/history/entities/:kind/:id", historyEntityStateHandler);
app.get("/api/user/history/entities/:kind/:id", historyEntityStateHandler);

// Entity revisions
const historyEntityRevisionsHandler = (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const kind = c.req.param("kind");
  const id = c.req.param("id");
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json(getEntityRevisions(db, kind, id, limit));
};
app.get("/api/projects/:pid/history/entities/:kind/:id/revisions", historyEntityRevisionsHandler);
app.get("/api/user/history/entities/:kind/:id/revisions", historyEntityRevisionsHandler);

// Diff between two commits for an entity
const historyDiffHandler = async (c: any) => {
  const scope = historyScope(c);
  const entityParam = c.req.query("entity");
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!entityParam || !from || !to) return c.json({ error: "entity, from, to required" }, 400);

  const parts = entityParam.split(":");
  const kind = parts[0]!;
  const id = parts.slice(1).join(":");
  if (!kind || !id) return c.json({ error: "entity format: kind:id" }, 400);

  const ref = { kind: kind as any, id };
  const workTree = getWorkTree(scope);
  const resolver = scope.kind === "project" ? projectEntities : userEntities;

  const fromFiles = await gitLsTree(scope, from);
  const toFiles = await gitLsTree(scope, to);
  const allFiles = new Set([...fromFiles, ...toFiles]);
  const entityFiles = [...allFiles].filter((f) => {
    const refs = resolver(join(workTree, f), workTree);
    return refs.some((r) => r.kind === kind && r.id === id);
  });

  let fromContent: string | null = null;
  let toContent: string | null = null;
  for (const file of entityFiles) {
    const fc = fromFiles.includes(file) ? await gitShowFile(scope, from, file) : null;
    const tc = toFiles.includes(file) ? await gitShowFile(scope, to, file) : null;
    fromContent = fromContent ? fromContent + "\n" + (fc ?? "") : fc;
    toContent = toContent ? toContent + "\n" + (tc ?? "") : tc;
  }

  return c.json(entityDiff(ref, fromContent, toContent));
};
app.get("/api/projects/:pid/history/diff", historyDiffHandler);
app.get("/api/user/history/diff", historyDiffHandler);

// Pins
const historyPinHandler = async (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const body = await c.req.json();
  if (!body.commitId) return c.json({ error: "commitId required" }, 400);
  try {
    pin(db, body.commitId, body.note);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
};
app.post("/api/projects/:pid/history/pin", historyPinHandler);
app.post("/api/user/history/pin", historyPinHandler);

const historyUnpinHandler = async (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const commitId = c.req.param("commitId");
  const removed = unpin(db, commitId);
  return removed ? c.json({ ok: true }) : c.json({ error: "pin not found" }, 404);
};
app.delete("/api/projects/:pid/history/pin/:commitId", historyUnpinHandler);
app.delete("/api/user/history/pin/:commitId", historyUnpinHandler);

const historyPinsListHandler = (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  return c.json(listPins(db));
};
app.get("/api/projects/:pid/history/pins", historyPinsListHandler);
app.get("/api/user/history/pins", historyPinsListHandler);

// Restore — plan / apply / discard
const historyRestorePlanHandler = async (c: any) => {
  const scope = historyScope(c);
  const db = getIndex(scope);
  if (!db) return c.json({ error: "history index not ready" }, 503);
  const body = await c.req.json();

  const target: RestoreTarget = body.at
    ? { type: "timestamp", at: body.at }
    : { type: "change", changeId: body.changeId };

  if (!body.at && !body.changeId) return c.json({ error: "changeId or at required" }, 400);

  const selection: EntitySelection = body.entities ?? "all";

  try {
    const plan = await planRestore(scope, db, target, selection);
    return c.json(plan);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
};
app.post("/api/projects/:pid/history/restore/plan", historyRestorePlanHandler);
app.post("/api/user/history/restore/plan", historyRestorePlanHandler);

const historyRestoreApplyHandler = async (c: any) => {
  const scope = historyScope(c);
  const body = await c.req.json();
  if (!body.planId) return c.json({ error: "planId required" }, 400);

  const actor: ActorInfo = { type: "human" };
  try {
    const result = await applyRestore(scope, body.planId, actor);
    if (!result.ok && result.failed?.some((f) => f.error.startsWith("DRIFT"))) {
      return c.json({ error: "DRIFT", details: result.failed }, 409);
    }
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
};
app.post("/api/projects/:pid/history/restore/apply", historyRestoreApplyHandler);
app.post("/api/user/history/restore/apply", historyRestoreApplyHandler);

const historyRestoreDiscardHandler = async (c: any) => {
  const scope = historyScope(c);
  const body = await c.req.json();
  if (!body.planId) return c.json({ error: "planId required" }, 400);
  try {
    discardPlan(scope, body.planId);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
};
app.post("/api/projects/:pid/history/restore/discard", historyRestoreDiscardHandler);
app.post("/api/user/history/restore/discard", historyRestoreDiscardHandler);

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
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "themes", body.themeId), { type: "human" });
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
    const result = activateTheme(body.cwd, body.themeId);
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "themes", body.themeId), { type: "human" });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch("/api/ui/themes/:id", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  try {
    const themeId = c.req.param("id");
    const result = patchTheme(body.cwd, themeId, {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
    });
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "themes", themeId), { type: "human" });
    return c.json(result);
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
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "fonts", body.fontId), { type: "human" });
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
    const result = activateFont(body.cwd, body.fontId);
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "fonts", body.fontId), { type: "human" });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch("/api/ui/fonts/:id", async (c) => {
  const body = await c.req.json();
  if (typeof body.cwd !== "string") return c.json({ error: "cwd required" }, 400);
  try {
    const fontId = c.req.param("id");
    const result = patchFont(body.cwd, fontId, {
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
      ...(typeof body.archived === "boolean" ? { archived: body.archived } : {}),
    });
    const project = getProjectByPath(body.cwd);
    if (project) recordAttributionHint({ kind: "project", projectId: project.id }, join(body.cwd, ".modus", "fonts", fontId), { type: "human" });
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ── Vaults ──

app.get("/api/vaults", (c) => APP_PATHS.instance
  ? c.json({ error: "Vault registry control is available only from Main" }, 403)
  : c.json(listVaultsForApi()));

app.post("/api/vaults", async (c) => {
  const result = createVaultForApi(await c.req.json().catch(() => null));
  return result.ok
    ? c.json(result.value)
    : c.json({ error: result.error }, result.status);
});

app.patch("/api/vaults/:slug", async (c) => {
  const result = updateVaultForApi(c.req.param("slug"), await c.req.json().catch(() => null));
  return result.ok
    ? c.json(result.value)
    : c.json({ error: result.error }, result.status);
});

app.post("/api/vaults/:slug/repair", async (c) => {
  const result = repairVaultForApi(c.req.param("slug"), await c.req.json().catch(() => null));
  return result.ok
    ? c.json(result.value)
    : c.json({ error: result.error }, result.status);
});

app.get("/api/vaults/:slug/policy", (c) => {
  const result = getVaultPolicyForApi(c.req.param("slug"));
  return result.ok
    ? c.json(result.value)
    : c.json({ error: result.error }, result.status);
});

app.put("/api/vaults/:slug/policy", async (c) => {
  const result = setVaultPolicyForApi(c.req.param("slug"), await c.req.json().catch(() => null));
  return result.ok
    ? c.json(result.value)
    : c.json({ error: result.error }, result.status);
});

// ── Modus Plugins ──

app.get("/api/plugins", (c) => {
  // Skills are disclosed with the plugin: shipping one ships behavior, not just
  // capability, and the About surface is where that belongs.
  return c.json(listModusPlugins().map((plugin) => {
    const providedSkills = listPluginSkills(plugin).map(({ name, description }) => ({ name, description }));
    return providedSkills.length ? { ...plugin, providedSkills } : plugin;
  }));
});

app.post("/api/plugins", async (c) => {
  try {
    const body = await c.req.json() as { path?: string; id?: string; name?: string; enabled?: boolean };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return c.json({ error: "path is required" }, 400);
    }
    const plugin = registerModusPlugin(body.path, {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    });
    return c.json(plugin);
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to register plugin" }, 400);
  }
});

app.patch("/api/plugins/:id", async (c) => {
  try {
    const body = await c.req.json() as { path?: string; name?: string; enabled?: boolean };
    const plugin = patchModusPlugin(c.req.param("id"), body);
    if (!plugin) return c.json({ error: "plugin not found" }, 404);
    return c.json(plugin);
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to update plugin" }, 400);
  }
});

app.delete("/api/plugins/:id", (c) => {
  if (!unregisterModusPlugin(c.req.param("id"))) {
    return c.json({ error: "plugin not found" }, 404);
  }
  return c.json({ ok: true });
});

app.get("/api/plugins/:id/settings", (c) => {
  try {
    return c.json(getPluginSettings(c.req.param("id"), {
      cwd: c.req.query("cwd"),
      userProfile: c.req.query("userProfile"),
    }));
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to read plugin settings" }, 404);
  }
});

app.patch("/api/plugins/:id/settings", async (c) => {
  try {
    const body = await c.req.json() as { values?: Record<string, unknown> };
    if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
      return c.json({ error: "values object is required" }, 400);
    }
    return c.json(patchScopedPluginSettings(c.req.param("id"), body.values, {
      cwd: c.req.query("cwd"),
      userProfile: c.req.query("userProfile"),
    }));
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to update plugin settings" }, 400);
  }
});

// ── Page inspection ──
//
// A page can only be judged by looking at it, and looking at it has meant a
// human with the app open. This is the readback channel for the browser-side
// page inspector: the client measures a rendered page and posts the result
// here, and whoever is authoring the page reads it back.
//
// Deliberately in-memory and last-only. It is a debugging surface, not a
// record — persisting layout measurements would keep stale geometry around
// long after the page that produced it changed.

type StoredPageInspectReport = { receivedAt: number; report: unknown };
const pageInspectReports = new Map<string, StoredPageInspectReport>();
const PAGE_INSPECT_MAX_PAGES = 20;

app.post("/api/page-inspect", async (c) => {
  const body = await c.req.json().catch(() => null) as { pageId?: unknown } | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "expected a page inspection report" }, 400);
  }
  const pageId = typeof body.pageId === "string" && body.pageId ? body.pageId : "unknown";
  // Oldest-out rather than unbounded: a long session flipping between pages
  // should not accumulate reports nobody will read.
  if (!pageInspectReports.has(pageId) && pageInspectReports.size >= PAGE_INSPECT_MAX_PAGES) {
    const oldest = pageInspectReports.keys().next().value;
    if (oldest) pageInspectReports.delete(oldest);
  }
  pageInspectReports.set(pageId, { receivedAt: Date.now(), report: body });
  return c.json({ ok: true, pageId });
});

app.get("/api/page-inspect", (c) => {
  const pageId = c.req.query("pageId");
  if (pageId) {
    const stored = pageInspectReports.get(pageId);
    if (!stored) return c.json({ error: `no inspection report for page "${pageId}"` }, 404);
    return c.json(stored);
  }
  return c.json({
    pages: [...pageInspectReports.entries()].map(([id, stored]) => ({
      pageId: id,
      receivedAt: stored.receivedAt,
    })),
  });
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
  // Same chain without the user-profile layer, so global-scoped settings
  // resolve to the value every client shares rather than this caller's.
  const sharedConfig = getResolvedClientExtensionsConfig(cwd);
  return c.json(
    listClientExtensions({ cwd, userProfile }).map((extension) => ({
      id: extension.id,
      fileName: extension.fileName,
      source: extension.source,
      pluginId: extension.pluginId,
      pluginPath: extension.pluginPath,
      enabled: extension.enabled,
      moduleUrl: `/api/client-extensions/${encodeURIComponent(extension.id)}/module${moduleQuery}`,
      meta: extension.meta,
      settingsValues: resolveExtensionSettings(
        extension.meta.settings,
        config.settings?.[extension.id],
        sharedConfig.settings?.[extension.id],
      ),
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
    // Split by declared scope. A global-scoped value is one the harness itself
    // consumes, so writing it into a single user profile would leave every
    // other client resolving nothing — it goes current-Vault-wide instead.
    const schema = getClientExtensionById(id, { cwd: c.req.query("cwd"), userProfile: userProfileName })
      ?.meta.settings ?? {};
    const userSettings: Record<string, unknown> = {};
    const globalSettings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body.settings)) {
      const def = schema[key];
      // The renderer's min/max attributes only constrain the form. Any client can
      // PATCH whatever it likes, and a global-scoped value lands Vault-wide for
      // every other client, so the declared bounds are enforced here too.
      if (def?.type === "number" && value !== null && value !== undefined) {
        const error = settingNumberError(key, value, def);
        if (error) return c.json({ error }, 400);
      }
      if (def && extensionSettingScope(def) === "global") globalSettings[key] = value;
      else userSettings[key] = value;
    }

    if (Object.keys(userSettings).length) {
      ext.settings = { ...(ext.settings ?? {}), [id]: { ...(ext.settings?.[id] ?? {}), ...userSettings } };
    }

    if (Object.keys(globalSettings).length) {
      const config = getStoredGlobalConfig();
      const clientExtensions = config.clientExtensions ?? {};
      saveGlobalConfig({
        ...config,
        clientExtensions: {
          ...clientExtensions,
          settings: {
            ...(clientExtensions.settings ?? {}),
            [id]: { ...(clientExtensions.settings?.[id] ?? {}), ...globalSettings },
          },
        },
      });
    }
  }

  patchUserProfileUiConfig(userProfileName, { clientExtensions: ext });
  return c.json({ ok: true });
});

const WHISPER_EXTENSION_ID = "whisper-transcribe";

/** Read one whisper setting from the layers the backend owns, then from the
 *  caller's profile. Both the endpoint and the secret name are consumed by the
 *  harness, so the shared value has to win — a per-profile-only read resolves
 *  nothing on any client that never opened the settings form. The profile read
 *  remains as a fallback for installs configured before these settings declared
 *  a scope. */
function readWhisperSetting(key: string, cwd?: string, userProfile?: string): {
  shared?: string;
  profile?: string;
} {
  const pick = (settings: Record<string, unknown> | undefined) => {
    const value = settings?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    shared: pick(getResolvedClientExtensionsConfig(cwd).settings?.[WHISPER_EXTENSION_ID]),
    profile: pick(getResolvedClientExtensionsConfig(cwd, userProfile).settings?.[WHISPER_EXTENSION_ID]),
  };
}

function readWhisperSecretName(cwd?: string, userProfile?: string): string | undefined {
  const { shared, profile } = readWhisperSetting("whisperSecretName", cwd, userProfile);
  return shared ?? profile;
}

app.post("/api/whisper/transcribe", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
    // The endpoint is deliberately NOT read from the request. The backend is
    // what dials it, so it is backend configuration; taking it from whichever
    // client was recording meant a phone with an unconfigured profile sent
    // nothing and the harness quietly fell back to its own loopback address.
    const cwd = c.req.query("cwd");
    const userProfile = c.req.query("userProfile");
    const configuredUrl = readWhisperSetting("whisperUrl", cwd, userProfile);
    const endpoint = resolveWhisperEndpoint({
      sharedSetting: configuredUrl.shared,
      profileSetting: configuredUrl.profile,
      env: process.env.WHISPER_URL,
    });
    if (endpoint.kind === "invalid") return c.json({ error: endpoint.error }, 400);
    const whisperUrl = endpoint.url;
    // Origin is logged because it is the only thing separating the desktop shell
    // (tauri.localhost) from a browser reaching the harness over the network.
    // Without it a "STT is broken on my phone" report cannot be told apart from
    // a healthy desktop request in the backend log, which is the only diagnostic
    // surface a packaged build has.
    console.log("[whisper/transcribe] received", {
      name: file.name,
      size: file.size,
      type: file.type,
      whisperUrl,
      urlSource: endpoint.source,
      origin: c.req.header("Origin") ?? "(none)",
    });

    const whisperBody = new FormData();
    whisperBody.set("file", file, file.name);
    whisperBody.set("response_format", "verbose_json");
    const model = form.get("model");
    if (typeof model === "string" && model.trim()) whisperBody.set("model", model.trim());
    const language = form.get("language");
    if (typeof language === "string" && language.trim()) whisperBody.set("language", language.trim());

    const headers: Record<string, string> = {};
    const credential = resolveWhisperCredential({
      secretName: readWhisperSecretName(cwd, userProfile),
      targetUrl: whisperUrl,
      lookup: resolveSecret,
    });
    if (credential.kind === "reject") return c.json({ error: credential.error }, 400);
    if (credential.kind === "attach") headers.Authorization = credential.authorization;

    // A refused connection to an endpoint nobody configured is a configuration
    // problem, and saying "transcription failed" sends the user looking at
    // their microphone or their network instead of their settings.
    let upstream: Response;
    try {
      upstream = await fetch(whisperUrl, {
        method: "POST",
        headers,
        body: whisperBody,
      });
    } catch (fetchErr: any) {
      const message = describeWhisperFetchFailure(endpoint, fetchErr?.message);
      console.error("[whisper/transcribe] unreachable", {
        whisperUrl,
        urlSource: endpoint.source,
        configured: endpoint.configured,
        error: fetchErr?.message,
      });
      return c.json({ error: message, whisperUrl, configured: endpoint.configured }, 502);
    }
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

    // Filter segments to suppress silence/noise hallucinations before they reach
    // the composer. whisper.cpp verbose_json commonly includes no_speech_prob;
    // avg_logprob is used when present.
    const NO_SPEECH_THRESHOLD = 0.6;
    const MIN_AVG_LOGPROB = -1.0;
    let text: string;
    if (Array.isArray(parsed?.segments) && parsed.segments.length > 0) {
      text = parsed.segments
        .filter((seg: any) => (seg.no_speech_prob ?? 0) < NO_SPEECH_THRESHOLD)
        .filter((seg: any) => seg.avg_logprob === undefined || seg.avg_logprob >= MIN_AVG_LOGPROB)
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

// ── Actions ──

import {
  initActions, stopActions, getActions, getActionState,
  triggerAction, handleWebhook, updateActionConfig,
  resetAction, setActionPreference, getActionPreferences,
  reloadActions, cancelExecution, startNewExecution,
  addActionTag, removeActionTag, getActionScopeKey,
} from "./action-runner";
import { initWakeScheduler } from "./wake-scheduler";
import { getActionRuns as dbGetActionRuns, clearActionRuns, getExecutions, getRunsByExecution } from "./db";

function actionResolveQuery(c: any): { userProfile?: string; cwd?: string } {
  const params = new URL(c.req.url).searchParams;
  return {
    userProfile: params.get("userProfile") ?? undefined,
    cwd: params.get("cwd") ?? undefined,
  };
}

function actionResolveOpts(c: any, body?: any): { userProfile?: string; cwd?: string } {
  const query = actionResolveQuery(c);
  return {
    userProfile: body?.userProfile ?? query.userProfile,
    cwd: body?.cwd ?? query.cwd,
  };
}

app.get("/api/actions", (c) => {
  return c.json(getActions(actionResolveQuery(c)));
});

app.get("/api/actions/:name", (c) => {
  const name = c.req.param("name");
  const state = getActionState(name, actionResolveQuery(c));
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
  return c.json(dbGetActionRuns(name, limit, getActionScopeKey(name, actionResolveQuery(c))));
});

// ── Execution endpoints ──

app.get("/api/actions/:name/executions", (c) => {
  const name = c.req.param("name");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(getExecutions(name, limit, getActionScopeKey(name, actionResolveQuery(c))));
});

app.get("/api/actions/:name/executions/:execId/runs", (c) => {
  const execId = Number(c.req.param("execId"));
  if (isNaN(execId)) return c.json({ error: "invalid execution id" }, 400);
  return c.json(getRunsByExecution(execId));
});

app.post("/api/actions/:name/executions", (c) => {
  const name = c.req.param("name");
  const result = startNewExecution(name, actionResolveQuery(c));
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true, executionId: result.executionId });
});

app.delete("/api/actions/:name/executions/:execId", (c) => {
  const name = c.req.param("name");
  const execId = Number(c.req.param("execId"));
  if (isNaN(execId)) return c.json({ error: "invalid execution id" }, 400);
  const ok = cancelExecution(name, execId, actionResolveQuery(c));
  if (!ok) return c.json({ error: "execution not found or not active" }, 404);
  return c.json({ ok: true });
});

app.post("/api/actions/:name/trigger", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const ok = await triggerAction(name, actionResolveOpts(c, body));
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
  const state = getActionState(name, actionResolveQuery(c));
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
  const opts = actionResolveQuery(c);
  const state = getActionState(name, opts);
  if (!state) return c.json({ error: "action not found" }, 404);
  clearActionRuns(name, state.scopeKey);
  return c.json({ ok: true });
});

app.post("/api/actions/:name/reset", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const opts = actionResolveOpts(c, body);
  const ok = resetAction(name, opts);
  if (!ok) return c.json({ error: "action not found or running" }, 400);
  if (body.skipConfirm) {
    setActionPreference(name, "skipResetConfirm", true, opts);
  }
  return c.json({ ok: true });
});

app.get("/api/actions/:name/preferences", (c) => {
  const name = c.req.param("name");
  return c.json(getActionPreferences(name, actionResolveQuery(c)));
});

app.post("/api/actions/:name/tags", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const tag = body.tag;
  if (!tag || typeof tag !== "string") return c.json({ error: "tag required" }, 400);
  const ok = addActionTag(name, tag.toLowerCase().trim(), actionResolveQuery(c));
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/actions/:name/tags/:tag", (c) => {
  const name = c.req.param("name");
  const tag = c.req.param("tag");
  const ok = removeActionTag(name, tag, actionResolveQuery(c));
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.patch("/api/actions/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const ok = updateActionConfig(name, body, actionResolveOpts(c, body));
  if (!ok) return c.json({ error: "action not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/actions/reload", (c) => {
  reloadActions();
  const actions = getActions(actionResolveQuery(c));
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

// ── Open in native file explorer (Windows Explorer / macOS Finder / Linux file manager) ──

app.post("/api/open-in-folder", async (c) => {
  const body = await c.req.json<{ path: string }>();
  if (!body.path) return c.json({ error: "path required" }, 400);
  try {
    const abs = resolve(body.path);
    let isDir = false;
    try { isDir = statSync(abs).isDirectory(); } catch {}
    const plat = process.platform;

    if (plat === "win32") {
      if (isDir) {
        Bun.spawn(["explorer.exe", abs], { stdout: "ignore", stderr: "ignore" });
      } else {
        Bun.spawn(["explorer.exe", `/select,${abs}`], { stdout: "ignore", stderr: "ignore" });
      }
    } else if (plat === "darwin") {
      const args = isDir ? ["open", abs] : ["open", "-R", abs];
      Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
    } else {
      const target = isDir ? abs : dirname(abs);
      Bun.spawn(["xdg-open", target], { stdout: "ignore", stderr: "ignore" });
    }
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

/**
 * Mint a ticket for a raw-file URL that cannot carry a header — an `<img>` src,
 * an open-in-a-new-tab link, a link handed to the share sheet.
 *
 * Header-authenticated, so the ticket never grants more than the caller had, and
 * bound to this one path for a few minutes.
 */
app.post("/api/file/ticket", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
  const body = await c.req.json().catch(() => ({}));
  const filePath = typeof body?.path === "string" ? body.path : "";
  if (!filePath) return c.json({ error: "path required" }, 400);

  const abs = resolve(filePath);
  if (!(await Bun.file(abs).exists())) return c.json({ error: "not found" }, 404);

  const ticket = mintFileTicket(abs);
  return c.json({ ticket, expiresAt: Date.now() + FILE_TICKET_TTL_MS });
});

app.get("/api/file/raw", async (c) => {
  const authError = requireConfiguredFileApiAuth(c);
  if (authError) return authError;
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

app.get("/api/stats/checkpoints", (c) => {
  const protectedSessionIds = new Set(getAllActiveSessions().map((session) => session.sessionId));
  return c.json(planCheckpointMaintenance({ rows: listAllCheckpoints(), protectedSessionIds }));
});

app.post("/api/maintenance/checkpoints", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body?.dryRun !== true) {
    return c.json({
      error: "checkpoint maintenance currently requires dryRun:true; apply remains disabled until a reviewed planId is confirmed",
    }, 400);
  }
  const protectedSessionIds = new Set(getAllActiveSessions().map((session) => session.sessionId));
  return c.json(planCheckpointMaintenance({ rows: listAllCheckpoints(), protectedSessionIds }));
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
    if (idx >= 0 && idx < analytics.buckets.length) analytics.buckets[idx]!.touches += 1;

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

  const account = await probeClaudeAccount();

  // Get period-based cost summaries from local DB
  const costs = getPeriodCosts(userProfile);

  return c.json({ account, costs });
});

app.get("/api/gemini/usage", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd") ?? process.cwd();
  const { fetchGeminiUsageSnapshot } = await import("./gemini-usage");
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

import { listMoves, getMove, activateMove, attachMove, activateAttachedMove, detachMove, getMoveRuns, getToken, getActiveTokensForSession, handleMoveApiSubmit, resolveMoveLocation, resolveMoveToolViewToken, getActiveWidgetForSession, rekeyMoveRegistrySession, rekeyMoveByToken, deactivateAmbientMove, getActiveAmbientMoves } from "./move-runner";
import { getMoveRunsBySession, getMoveRunById, getRecentMoveRuns } from "./move-db";
import { isMoveOpParseError, parseMoveOpFormData, parseMoveOpJson } from "./move-op-request";
import { resolveDeclaredMoveComponent } from "./move-component";
import { handleModusMcpRequest } from "./modus-mcp";

// List available moves for a CWD
app.get("/api/moves", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(listMoves(cwd));
});

// ── Skills ──

// Installed skills visible from a project (project, user home, enabled plugins).
// Installed is not the same as attached: this is what the composer's picker can
// offer, since a user choosing one is itself the decision to load it.
app.get("/api/skills", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  return c.json(listInstalledSkills(cwd).map((skill) => ({
    name: skill.name,
    description: skill.description,
    origin: skill.origin,
    pluginId: skill.pluginId,
    dir: skill.dir,
  })));
});

// Activation payload — what the composer injects when a skill is chosen.
// Frontmatter stripped and `Base Path:` prefixed, matching the Agent Skills
// ecosystem; the raw file is still reachable via the file API for previews.
app.get("/api/skills/:name", (c) => {
  const cwd = new URL(c.req.url).searchParams.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);
  const skill = getInstalledSkill(c.req.param("name"), cwd);
  if (!skill) return c.json({ error: "skill not found" }, 404);
  const text = buildSkillPayload(skill);
  if (text === null) return c.json({ error: "skill could not be read" }, 404);
  return c.json({ name: skill.name, description: skill.description, dir: skill.dir, origin: skill.origin, text });
});

// Resolve the move-owned transcript view for a reusable move API token. This
// static route must precede /api/moves/:name or "resolve-token" is consumed as
// a move name by the router.
app.get("/api/moves/resolve-token", async (c) => {
  const token = new URL(c.req.url).searchParams.get("token");
  if (!token) return c.json({ error: "token required" }, 400);
  return c.json(await resolveMoveToolViewToken(token) ?? null);
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
  const params = new URL(c.req.url).searchParams;
  const cwd = params.get("cwd");
  if (!cwd) return c.json({ error: "cwd required" }, 400);

  const move = getMove(name, cwd);
  if (!move) return c.json({ error: "move not found" }, 404);
  const component = resolveDeclaredMoveComponent(move, params.get("component"));
  if (!component) return c.json({ error: "move component not declared" }, 404);

  const location = resolveMoveLocation(name, cwd);
  if (!location) return c.json({ error: "move not found" }, 404);

  const srcPath = join(location.dir, component);
  try {
    const { statSync } = await import("fs");
    const mtime = statSync(srcPath).mtimeMs;

    // moduleUrl carries no version or hash, so without a validator a browser is
    // free to reuse a widget bundle forever and never sees an authored edit. That
    // stranded a phone on a stale widget while the desktop had refetched, which
    // reads as "the fix works here but not there". no-cache means revalidate, not
    // do-not-store: the 304 below keeps the common case cheap.
    const etag = moveAssetETag(mtime);
    if (moveAssetNotModified(c.req.header("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: moveAssetHeaders("application/javascript", etag) });
    }

    const cached = widgetCache.get(srcPath);
    if (cached && cached.mtime === mtime) {
      return new Response(cached.js, { headers: moveAssetHeaders("application/javascript", etag) });
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

    const js = await result.outputs[0]!.text();
    widgetCache.set(srcPath, { mtime, js });
    return new Response(js, { headers: moveAssetHeaders("application/javascript", etag) });
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
    const { readFileSync, statSync } = await import("fs");
    const etag = moveAssetETag(statSync(cssPath).mtimeMs);
    if (moveAssetNotModified(c.req.header("If-None-Match"), etag)) {
      return new Response(null, { status: 304, headers: moveAssetHeaders("text/css", etag) });
    }
    const css = readFileSync(cssPath, "utf-8");
    return new Response(css, { headers: moveAssetHeaders("text/css", etag) });
  } catch {
    return new Response("", { status: 404 });
  }
});

// Call a move API op from the frontend (caller: "user")
app.post("/api/moves/:name/op", async (c) => {
  // Two content types, one envelope. Multipart exists so authored content can
  // send media without base64ing it through JSON; see move-op-request.ts for
  // the field contract and why `json` is a separate part.
  const contentType = c.req.header("Content-Type") ?? "";
  const parsed = contentType.includes("multipart/form-data")
    ? parseMoveOpFormData(await c.req.formData())
    : parseMoveOpJson(await c.req.json());
  if (isMoveOpParseError(parsed)) return c.json({ error: parsed.error }, 400);

  const result = await handleMoveApiSubmit(
    parsed.apiToken,
    { op: parsed.op, ...parsed.data },
    "user",
  );
  return c.json(result, result.ok ? 200 : 400);
});

// Modus MCP endpoint — Streamable HTTP transport for modus_submit
app.all("/api/mcp/modus", async (c) => {
  return handleModusMcpRequest(c.req.raw);
});
// Suffixed form: the first path segment is a session's skill scope key. An
// unknown or absent key simply yields the plain single-tool surface.
app.all("/api/mcp/modus/*", async (c) => {
  const suffix = c.req.path.slice("/api/mcp/modus/".length).split("/")[0];
  return handleModusMcpRequest(c.req.raw, suffix || undefined);
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
import { exportMissionTrace } from "./mission-export";

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
  const result = await resumeMissionRun(id);
  if (!result.ok) return c.json(result, 400);
  return c.json(result);
});

// Export mission trace to project folder
app.post("/api/missions/runs/:id/export", (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);
  const result = exportMissionTrace(id);
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

// Sessions that wrote or edited one file, newest first. Backs the code editor's
// file-history context menu. Reads file_observations, not the events table —
// see getSessionsForFile for why.
app.get("/api/trace/file-sessions", (c) => {
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit ? parseInt(rawLimit, 10) : 3;
  if (rawLimit && (isNaN(limit) || limit < 1)) return c.json({ error: "invalid limit" }, 400);
  return c.json({ sessions: getSessionsForFile(path, Math.min(limit, 25)) });
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
      kind: body.kind,
      ownerType: body.ownerType,
      ownerName: body.ownerName,
      provider: body.provider,
      interactive: body.interactive,
    });
    return c.json({
      id: term.id,
      shell: term.shell,
      cwd: term.cwd,
      cols: term.cols,
      rows: term.rows,
      sessionId: term.sessionId,
      sessionOriginId: term.sessionOriginId,
      kind: term.kind,
      ownerType: term.ownerType,
      ownerName: term.ownerName,
      provider: term.provider,
      interactive: term.interactive,
      pid: term.pid,
      stopMode: term.stopMode,
      canStop: term.canStop,
      canRestart: term.canRestart,
      status: "running",
      createdAt: term.createdAt,
      lastOutputAt: term.lastOutputAt,
    });
  } catch (err) {
    console.error("Failed to create terminal:", err);
    return c.json({ error: String(err) }, 500);
  }
});

app.get("/api/terminals", (c) => {
  const filterSessionId = c.req.query("sessionId") ?? null;
  const filterOwnerType = c.req.query("ownerType") ?? null;
  const filterOwnerName = c.req.query("ownerName") ?? null;
  const active = getAllActiveTerminals()
    .filter(t => !filterSessionId || t.sessionId === filterSessionId)
    .filter(t => !filterOwnerType || t.ownerType === filterOwnerType)
    .filter(t => !filterOwnerName || t.ownerName === filterOwnerName)
    .map(t => ({
      id: t.id,
      shell: t.shell,
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      sessionId: t.sessionId,
      sessionOriginId: t.sessionOriginId,
      kind: t.kind,
      ownerType: t.ownerType,
      ownerName: t.ownerName,
      provider: t.provider,
      interactive: t.interactive,
      pid: t.pid,
      stopMode: t.stopMode,
      canStop: t.canStop,
      canRestart: t.canRestart,
      createdAt: t.createdAt,
      lastOutputAt: t.lastOutputAt,
      clients: t.clients.size,
      status: "running",
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
      sessionOriginId: active.sessionOriginId,
      kind: active.kind,
      ownerType: active.ownerType,
      ownerName: active.ownerName,
      provider: active.provider,
      interactive: active.interactive,
      pid: active.pid,
      stopMode: active.stopMode,
      canStop: active.canStop,
      canRestart: active.canRestart,
      createdAt: active.createdAt,
      lastOutputAt: active.lastOutputAt,
      clients: active.clients.size,
      status: "running",
    });
  }
  const row = getTerminalInfo(id);
  if (row) {
    return c.json({
      id: row.id,
      shell: row.shell,
      cwd: row.cwd,
      cols: row.cols,
      rows: row.rows,
      sessionId: row.session_id,
      sessionOriginId: row.session_origin_id,
      kind: row.kind,
      ownerType: row.owner_type,
      ownerName: row.owner_name,
      provider: row.provider,
      interactive: row.interactive === 1,
      pid: row.pid,
      stopMode: "observe",
      canStop: false,
      canRestart: false,
      createdAt: row.created_at,
      lastOutputAt: row.last_output_at,
      clients: 0,
      status: row.status,
    });
  }
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

app.post("/api/terminals/rekey-session", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const oldSessionId = typeof body.oldSessionId === "string" ? body.oldSessionId : "";
  const newSessionId = typeof body.newSessionId === "string" ? body.newSessionId : "";
  if (!oldSessionId || !newSessionId) {
    return c.json({ error: "oldSessionId and newSessionId are required" }, 400);
  }
  const { rekeyTerminalSession } = await import("./terminal-manager");
  const count = rekeyTerminalSession(oldSessionId, newSessionId);
  return c.json({ ok: true, count });
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

// Publish live harness module namespaces on the process global so packaged
// move shims resolve to server.js's singletons. Must run before any move loads.
initHarnessBridge();

// Cursor has to write MCP servers into the user's project while a turn runs, and
// that file carries resolved credentials. If a previous backend died mid-turn the
// restore never ran, so complete it now rather than leaving the file in place.
try {
  const recovered = cursorMcpConfigStore.recoverStranded();
  if (recovered > 0) {
    console.log(`[cursor] recovered ${recovered} project MCP config file(s) left by a previous run`);
  }
} catch (error) {
  console.warn(`[cursor] could not recover project MCP config files: ${error instanceof Error ? error.message : String(error)}`);
}

// Provider credential material lives in process-private temp directories. Remove
// any left by a dead process; directories owned by a live process are untouched.
try {
  const pruned = pruneAbandonedSensitiveTempDirectories();
  if (pruned > 0) console.log(`[providers] pruned ${pruned} abandoned private temporary director(ies)`);
} catch (error) {
  console.warn(`[providers] could not prune private temporary directories: ${error instanceof Error ? error.message : String(error)}`);
}

// Wire terminal auth checker (reuses same PIN + token auth as REST)
setAuthChecker((token: string) => {
  if (!AUTH_TOKEN && !getPin()) return true;  // no auth configured
  if (AUTH_TOKEN && token === AUTH_TOKEN) return true;
  if (browserSessions.validate(token)) return true;
  return false;
});
setOriginChecker((origin, req) => !origin || isAllowedBrowserOrigin(origin, {
  port: PORT,
  requestHost: req.headers.get("Host"),
  configuredOrigins: process.env.MODUS_ALLOWED_ORIGINS,
}));

const server = Bun.serve({
  fetch(req, server) {
    // Intercept WebSocket upgrade requests before Hono
    const wsResult = tryUpgradeTerminalWS(req, server);
    if (wsResult !== null) return wsResult;
    // Attach the socket peer address as an internal header. Always overwrite
    // any client-supplied value; PIN throttling trusts forwarded identity only
    // when this peer is loopback (for example, Tailscale Serve).
    const headers = new Headers(req.headers);
    headers.set("X-Modus-Peer-Address", server.requestIP(req)?.address ?? "unknown");
    const internalRequest = new Request(req, { headers });
    return app.fetch(internalRequest, server);
  },
  websocket: terminalWebSocket,
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // disable — SSE streams are long-lived; keepalives handle liveness
  tls: HARNESS_TLS_CERT && HARNESS_TLS_KEY
    ? {
        cert: Bun.file(HARNESS_TLS_CERT),
        key: Bun.file(HARNESS_TLS_KEY),
      }
    : undefined,
});
if (!server.port) throw new Error("Bun did not report the bound backend port");
PORT = server.port;
// Write the actually-bound port back to env so env-reading consumers agree with the
// real port. The desktop backend spawns us with HARNESS_PORT=0 (ephemeral); without this,
// getBuiltInMcpServers() builds http://127.0.0.1:0/api/mcp/modus (unconnectable), which
// silently drops the modus_submit MCP tool from every spawned session.
process.env.HARNESS_PORT = String(server.port);
const authModes = [AUTH_TOKEN && "token", getPin() && "pin"].filter(Boolean);
const protocol = HARNESS_TLS_CERT && HARNESS_TLS_KEY ? "https" : "http";
console.log(`Agent harness listening on ${protocol}://${HOST}:${PORT}${authModes.length ? ` (auth: ${authModes.join("+")})` : ""}`);

initActions();
initWakeScheduler();
loadPrompts();
startSessionReaper();
startMemoryWatchdog();

function publishDesktopReadiness(): void {
  const readyPath = process.env.MODUS_DESKTOP_READY_FILE?.trim();
  if (!readyPath) return;
  const temporaryPath = `${readyPath}.${process.pid}.tmp`;
  mkdirSync(dirname(readyPath), { recursive: true });
  const record = {
    event: "ready",
    pid: process.pid,
    port: PORT,
    instanceId: BACKEND_IDENTITY.id,
    version: process.env.MODUS_DESKTOP_VERSION?.trim() || "development",
  };
  writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx" });
  renameSync(temporaryPath, readyPath);
}

publishDesktopReadiness();

// ── Workspace history — shadow repos, index, fs-watcher subscriber ──

setCommitsPausedCheck(() => isCommitsPaused());

onShadowCommit((scope, record, entityOps) => {
  const db = getIndex(scope);
  if (db) {
    indexCommit(db, record, entityOps);
  }
});

async function initHistoryIndex(scope: ShadowScope, workTree: string): Promise<void> {
  const root = shadowRepoPath(scope);
  const db = openIndex(scope, root);
  const storedHead = getStoredHead(db);
  const currentHead = await gitHead(scope);

  if (currentHead && storedHead !== currentHead) {
    const records = await listCommits(scope, { limit: 99999 });
    const diffTrees = new Map<string, DiffTreeEntry[]>();
    for (const r of records) {
      diffTrees.set(r.id, await gitDiffTree(scope, r.id));
    }
    const resolver = scope.kind === "project" ? projectEntities : userEntities;
    rebuildIndex(db, records, diffTrees, workTree, resolver);
    const key = scope.kind === "project" ? `project:${scope.projectId}` : "user";
    console.log(`[workspace-history] rebuilt index for ${key} (${records.length} commits)`);
  }
}

(async () => {
  try {
    const userWorkTree = homeProfilesDir();
    await initShadowRepo({ kind: "user" }, userWorkTree);
    await initHistoryIndex({ kind: "user" }, userWorkTree);

    const registry = listProjects();
    for (const project of registry) {
      const projectJson = join(project.path, ".modus", "_project.json");
      if (existsSync(projectJson)) {
        const workTree = join(project.path, ".modus");
        await initShadowRepo({ kind: "project", projectId: project.id }, workTree);
        await initHistoryIndex({ kind: "project", projectId: project.id }, workTree);
      }
    }

    console.log("[workspace-history] shadow repos + indexes initialized");
  } catch (err: any) {
    console.warn("[workspace-history] init failed:", err.message);
  }
})();

subscribeFsEvents({
  write(event: FsChangeEvent) {
    if (!event.entry) return;
    const absPath = join(event.dir, event.entry);

    const registry = listProjects();
    for (const project of registry) {
      const modusRoot = join(project.path, ".modus");
      if (absPath.startsWith(modusRoot + "/") || absPath === modusRoot) {
        const scope: ShadowScope = { kind: "project", projectId: project.id };
        if (isTracked(absPath, scope, modusRoot)) {
          scheduleCommit(scope);
        }
        return;
      }
    }
  },
  close() {},
});

// Suppress AbortError rejections from provider internals (e.g. Gemini CLI retry loops)
process.on("unhandledRejection", (reason) => {
  if (reason && typeof reason === "object" && (reason as any).name === "AbortError") return;
  console.error("Unhandled rejection:", reason);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("Shutting down...");
  stopActions();
  stopSessionReaper();
  stopMemoryWatchdog();
  // Await provider teardown before exiting, or the provider CLI subprocess is
  // orphaned instead of reaped. Capped inside shutdownAll.
  await shutdownAll();
  shutdownAllTerminals();
  // Force-close active connections (WebSocket, SSE) so the port is released immediately.
  // Without this, Windows holds ghost sockets and the port stays bound after exit.
  server.stop(true);
  setTimeout(() => process.exit(0), 3000);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
