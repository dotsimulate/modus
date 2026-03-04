// Prevent nested session detection when launched from within Claude Code
delete process.env.CLAUDECODE;

import { loadSecrets, resolveSecret, isSecretSet, getSecretsInfo, setupPin } from "./secrets";
loadSecrets();

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  getAllProfiles, getProfile, listProfileNames,
  saveProfile, deleteProfile, getGlobalConfig, saveGlobalConfig,
  setUserName, getUserName,
  getUserProfile, listUserProfileNames, getAllUserProfiles,
  saveUserProfile, deleteUserProfile, patchUserProfile,
} from "./profiles";
import {
  listSessions, listSessionsForProjects,
  getSession, archiveSession, searchSessions,
  getEvents, upsertSession as dbUpsertSession,
  getDraft, setDraft,
  pruneSessionEvents, pruneAllSessionEvents, storageStats,
} from "./db";
import {
  startSession, queueMessage, stopSession, stopTask,
  getActiveSession, getAllActiveSessions, subscribe, shutdownAll,
  updateSessionConfig, resolvePermission,
  type SSEWriter,
} from "./session-manager";

const PORT = Number(process.env.HARNESS_PORT ?? 3777);
const HOST = "0.0.0.0";
const AUTH_TOKEN = process.env.HARNESS_TOKEN || "";

const app = new Hono();

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

// Token auth — skip if no HARNESS_TOKEN is set
// Also allows PIN-derived session tokens
app.use("/api/*", async (c, next) => {
  // Auth endpoints are always open
  if (c.req.path.startsWith("/api/auth/")) return next();

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

app.get("/health", (c) =>
  c.json({ status: "ok", uptime: process.uptime() })
);

// ── Profiles ──

app.get("/api/profiles", (c) => {
  const all = getAllProfiles();
  const list = Object.entries(all).map(([name, p]) => ({
    name,
    ...p,
    tools: p.tools ?? "all",
  }));
  return c.json(list);
});

app.get("/api/profiles/_global", (c) => {
  return c.json(getGlobalConfig());
});

app.put("/api/profiles/_global", async (c) => {
  const body = await c.req.json();
  saveGlobalConfig(body);
  return c.json({ ok: true });
});

app.get("/api/profiles/:name", (c) => {
  const name = c.req.param("name");
  const profile = getProfile(name);
  if (!profile) return c.json({ error: "profile not found" }, 404);
  return c.json({ name, ...profile });
});

app.put("/api/profiles/:name", async (c) => {
  const name = c.req.param("name");
  if (name.startsWith("_")) return c.json({ error: "reserved name" }, 400);
  const body = await c.req.json();
  if (!body.description || !body.prompt) {
    return c.json({ error: "description and prompt are required" }, 400);
  }
  saveProfile(name, body);
  return c.json({ ok: true, name });
});

app.delete("/api/profiles/:name", (c) => {
  const name = c.req.param("name");
  const deleted = deleteProfile(name);
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
  const body = await c.req.json();
  if (!body.displayName || !body.projects) {
    return c.json({ error: "displayName and projects are required" }, 400);
  }
  saveUserProfile(name, body);
  return c.json({ ok: true, name });
});

app.patch("/api/user-profiles/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const updated = patchUserProfile(name, body);
  if (!updated) return c.json({ error: "user profile not found" }, 404);
  return c.json({ ok: true, name, ...updated });
});

app.delete("/api/user-profiles/:name", (c) => {
  const name = c.req.param("name");
  const deleted = deleteUserProfile(name);
  if (!deleted) return c.json({ error: "user profile not found" }, 404);
  return c.json({ ok: true });
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

// ── Sessions ──

/** Resolve CWD prefixes from a user profile name (query param) */
function resolveProjectFilter(c: any): string[] | undefined {
  const profileName = new URL(c.req.url).searchParams.get("userProfile");
  if (!profileName) return undefined;
  const profile = getUserProfile(profileName);
  return profile?.projects;
}

app.get("/api/sessions/search", (c) => {
  const params = new URL(c.req.url).searchParams;
  const q = params.get("q")?.trim();
  if (!q) return c.json([]);
  const limit = Number(params.get("limit") ?? 20);
  const cwdPrefixes = resolveProjectFilter(c);
  return c.json(searchSessions(q, limit, cwdPrefixes));
});

app.get("/api/sessions", (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 50);
  const cwdPrefixes = resolveProjectFilter(c);
  if (cwdPrefixes && cwdPrefixes.length > 0) {
    return c.json(listSessionsForProjects(cwdPrefixes, limit));
  }
  return c.json(listSessions(limit));
});

app.get("/api/sessions/active", (c) => {
  // Merge in-memory active sessions with DB active sessions
  const memSessions = getAllActiveSessions().map((s) => ({
    id: s.sessionId,
    status: s.status,
    profile: s.profile ?? null,
    model: s.model ?? null,
    costUsd: s.costUsd,
    numTurns: s.numTurns,
    startedAt: s.startedAt,
    lastEventAt: s.lastEventAt,
    preview: s.preview,
    seq: s.seq,
    subscribers: s.subscribers.size,
    cwd: s.sdkOptions?.cwd ?? null,
  }));
  return c.json(memSessions);
});

// Create new session
app.post("/api/sessions", async (c) => {
  const body = await c.req.json();
  const { prompt } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  if (body.profile && !getProfile(body.profile)) {
    return c.json(
      { error: `unknown profile: ${body.profile}`, available: listProfileNames() },
      400,
    );
  }

  const session = startSession({
    prompt,
    attachments: body.attachments,
    profile: body.profile,
    model: body.model,
    maxTurns: body.maxTurns,
    effort: body.effort,
    cwd: body.cwd,
    tools: body.tools,
    disallowedTools: body.disallowedTools,
    loadProjectSettings: body.loadProjectSettings,
    sessionId: body.sessionId, // for resume
  });

  // Wait briefly for the init event to get the real session ID
  const start = Date.now();
  while (session.sessionId.startsWith("pending-") && Date.now() - start < 5000) {
    await new Promise((r) => setTimeout(r, 50));
  }

  return c.json({
    sessionId: session.sessionId,
    status: session.status,
  });
});

// Create empty session (DB row only, no SDK). Used by "new session" button.
app.post("/api/sessions/empty", async (c) => {
  const body = await c.req.json();
  const id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  dbUpsertSession({
    id,
    preview: "",
    profile: body.profile ?? null,
    model: body.model ?? null,
    status: "idle",
    messageCount: 0,
    costUsd: 0,
    cwd: body.cwd ?? null,
  });
  return c.json({ sessionId: id });
});

// Get session status
app.get("/api/sessions/:id/status", (c) => {
  const id = c.req.param("id");
  const active = getActiveSession(id);
  if (active) {
    return c.json({
      sessionId: active.sessionId,
      status: active.status,
      seq: active.seq,
      costUsd: active.costUsd,
      numTurns: active.numTurns,
      startedAt: active.startedAt,
      lastEventAt: active.lastEventAt,
      error: active.error,
    });
  }
  // Check DB for completed session
  const dbSession = getSession(id);
  if (dbSession) {
    return c.json({
      sessionId: dbSession.id,
      status: dbSession.status,
      seq: 0,
      costUsd: dbSession.total_cost_usd,
      numTurns: dbSession.message_count,
      startedAt: dbSession.created_at,
      lastEventAt: dbSession.updated_at,
      error: null,
    });
  }
  return c.json({ error: "session not found" }, 404);
});

// Subscribe to session events (SSE)
app.get("/api/sessions/:id/events", (c) => {
  const id = c.req.param("id");
  const afterSeq = Number(new URL(c.req.url).searchParams.get("after") ?? 0);

  return streamSSE(c, async (stream) => {
    // Send catch-up events from DB
    const pastEvents = getEvents(id, afterSeq);
    for (const evt of pastEvents) {
      await stream.writeSSE({
        event: evt.type,
        data: evt.data,
        id: String(evt.seq),
      });
    }

    // If session is still active, subscribe for live events
    // The session manager broadcasts "done" when the drain loop ends —
    // that flows through the writer and closes this connection naturally.
    const active = getActiveSession(id);
    if (active && active.status !== "done" && active.status !== "error") {
      let resolve: () => void;
      const done = new Promise<void>((r) => { resolve = r; });

      // Keep-alive: send SSE comment every 30s to prevent idle timeout
      const keepAlive = setInterval(async () => {
        try { await stream.writeSSE({ event: "ping", data: "{}", id: "" }); } catch { /* connection dead */ }
      }, 30_000);

      const writer: SSEWriter = {
        async write(event, data, seqId) {
          await stream.writeSSE({ event, data, id: seqId });
          if (event === "done") resolve();
        },
        close() { resolve(); },
      };

      const unsubscribe = subscribe(id, writer);
      stream.onAbort(() => { clearInterval(keepAlive); unsubscribe(); resolve(); });

      await done;
      clearInterval(keepAlive);
    } else {
      // Session already finished — send done immediately after catch-up
      await stream.writeSSE({ event: "done", data: "{}", id: "done" });
    }
  });
});

// Queue a message into a running/idle session
app.post("/api/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const { prompt } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const active = getActiveSession(id);
  if (!active) {
    // Session not active in memory — resume it via SDK
    const existing = getSession(id);
    const session = startSession({
      prompt,
      attachments: body.attachments,
      sessionId: id,
      profile: body.profile ?? existing?.profile ?? undefined,
    });
    const start = Date.now();
    while (session.sessionId.startsWith("pending-") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return c.json({ queued: true, status: session.status, sessionId: session.sessionId });
  }

  const queued = queueMessage(id, prompt, body.attachments);
  return c.json({ queued, status: active.status });
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
  const ok = updateSessionConfig(c.req.param("id"), body);
  return ok ? c.json({ ok: true }) : c.json({ error: "session not found" }, 404);
});

// Archive session (soft-delete — preserves data in DB)
app.delete("/api/sessions/:id", (c) => {
  // Stop if active
  stopSession(c.req.param("id"));
  archiveSession(c.req.param("id"));
  return c.json({ ok: true });
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

// ── Directory Browser ──
// Lists subdirectories at a given path for the CWD folder picker.
app.get("/api/browse", async (c) => {
  const raw = new URL(c.req.url).searchParams.get("path") ?? process.env.HOME ?? "/";
  // Resolve and sanitize — no traversal tricks
  const { resolve } = await import("path");
  const { readdir, stat } = await import("fs/promises");
  const target = resolve(raw);
  try {
    const info = await stat(target);
    if (!info.isDirectory()) return c.json({ error: "not a directory" }, 400);
    const entries = await readdir(target, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    // Also provide parent for navigation
    const parent = resolve(target, "..");
    return c.json({ path: target, parent: parent !== target ? parent : null, dirs });
  } catch (err: any) {
    return c.json({ error: err.code === "ENOENT" ? "not found" : err.message }, 400);
  }
});

// ── Memories (reads from agent_memory store) ──

const MEMORY_DIR = new URL("../agent_memory/memory", import.meta.url).pathname;

app.get("/api/memories", async (c) => {
  const { readdir, readFile } = await import("fs/promises");
  const { resolve } = await import("path");
  try {
    const files = await readdir(MEMORY_DIR);
    const memories: any[] = [];
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const text = await readFile(resolve(MEMORY_DIR, f), "utf-8");
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
        body,
      });
    }
    return c.json(memories);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ── Schedules ──

import {
  initScheduler, stopScheduler, getSchedules, getScheduleState,
  triggerSchedule, updateScheduleConfig,
} from "./scheduler";
import { getScheduleRuns as dbGetScheduleRuns } from "./db";

app.get("/api/schedules", (c) => {
  return c.json(getSchedules());
});

app.get("/api/schedules/:name", (c) => {
  const name = c.req.param("name");
  const state = getScheduleState(name);
  if (!state) return c.json({ error: "schedule not found" }, 404);
  return c.json({
    ...state.config,
    nextRunAt: state.nextRunAt,
    lastRunAt: state.lastRunAt,
    lastStatus: state.lastStatus,
    running: state.running,
  });
});

app.get("/api/schedules/:name/runs", (c) => {
  const name = c.req.param("name");
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 20);
  return c.json(dbGetScheduleRuns(name, limit));
});

app.post("/api/schedules/:name/trigger", async (c) => {
  const name = c.req.param("name");
  const ok = await triggerSchedule(name);
  if (!ok) return c.json({ error: "schedule not found or already running" }, 400);
  return c.json({ ok: true });
});

app.patch("/api/schedules/:name", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json();
  const ok = updateScheduleConfig(name, body);
  if (!ok) return c.json({ error: "schedule not found" }, 404);
  return c.json({ ok: true });
});

// ── Git ──

import { gitStatus, gitLog, gitShow } from "./git";

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

// ── Storage Stats & Compaction ──

app.get("/api/stats/storage", (c) => {
  return c.json(storageStats());
});

app.post("/api/prune", (c) => {
  const result = pruneAllSessionEvents();
  return c.json(result);
});

app.post("/api/prune/:sessionId", (c) => {
  const result = pruneSessionEvents(c.req.param("sessionId"));
  return c.json(result);
});

// ── Start ──

const server = Bun.serve({ fetch: app.fetch, port: PORT, hostname: HOST, idleTimeout: 255 });
const authModes = [AUTH_TOKEN && "token", getPin() && "pin"].filter(Boolean);
console.log(`Agent harness listening on http://${HOST}:${PORT}${authModes.length ? ` (auth: ${authModes.join("+")})` : ""}`);

initScheduler();

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  stopScheduler();
  shutdownAll();
  server.stop();
  setTimeout(() => process.exit(0), 3000);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
