// Prevent nested session detection when launched from within Claude Code
delete process.env.CLAUDECODE;

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { profiles } from "./profiles";
import {
  listSessions, getSession, deleteSession, getMessages,
  getEvents,
} from "./db";
import {
  startSession, queueMessage, interruptSession, stopSession, stopTask,
  getActiveSession, getAllActiveSessions, subscribe, shutdownAll,
  type SSEWriter,
} from "./session-manager";

const PORT = Number(process.env.HARNESS_PORT ?? 3777);
const HOST = "0.0.0.0";
const AUTH_TOKEN = process.env.HARNESS_TOKEN || "";

const app = new Hono();

// CORS for all API routes
app.use("/api/*", cors({ origin: "*" }));

// Token auth — skip if no HARNESS_TOKEN is set
app.use("/api/*", async (c, next) => {
  if (!AUTH_TOKEN) return next();
  const header = c.req.header("Authorization");
  const tokenParam = new URL(c.req.url).searchParams.get("token");
  if (header === `Bearer ${AUTH_TOKEN}` || tokenParam === AUTH_TOKEN) {
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

// ── Health ──

app.get("/health", (c) =>
  c.json({ status: "ok", uptime: process.uptime() })
);

// ── Profiles ──

app.get("/api/profiles", (c) => {
  const list = Object.entries(profiles).map(([name, p]) => ({
    name,
    description: p.description,
    model: p.model,
    maxTurns: p.maxTurns,
    tools: p.tools ?? "all",
    effort: p.effort,
  }));
  return c.json(list);
});

// ── Sessions ──

app.get("/api/sessions", (c) => {
  const limit = Number(new URL(c.req.url).searchParams.get("limit") ?? 50);
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
  }));
  return c.json(memSessions);
});

// Create new session
app.post("/api/sessions", async (c) => {
  const body = await c.req.json();
  const { prompt } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  if (body.profile && !profiles[body.profile]) {
    return c.json(
      { error: `unknown profile: ${body.profile}`, available: Object.keys(profiles) },
      400,
    );
  }

  const session = startSession({
    prompt,
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

// Get messages (high-level conversation)
app.get("/api/sessions/:id/messages", (c) => {
  return c.json(getMessages(c.req.param("id")));
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
      sessionId: id,
      profile: body.profile ?? existing?.profile ?? undefined,
    });
    const start = Date.now();
    while (session.sessionId.startsWith("pending-") && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return c.json({ queued: true, status: session.status, sessionId: session.sessionId });
  }

  const queued = queueMessage(id, prompt);
  return c.json({ queued, status: active.status });
});

// Interrupt current turn
app.post("/api/sessions/:id/interrupt", (c) => {
  const ok = interruptSession(c.req.param("id"));
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

// Delete session (DB cleanup)
app.delete("/api/sessions/:id", (c) => {
  // Stop if active
  stopSession(c.req.param("id"));
  deleteSession(c.req.param("id"));
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

// ── Legacy backward-compat endpoint ──
// Creates a session and immediately returns SSE event stream
app.post("/api/agent/stream", async (c) => {
  const body = await c.req.json();
  const { prompt } = body;
  if (!prompt) return c.json({ error: "prompt required" }, 400);

  const session = startSession({
    prompt,
    profile: body.profile,
    model: body.model,
    maxTurns: body.maxTurns,
    effort: body.effort,
    cwd: body.cwd,
    sessionId: body.sessionId,
  });

  return streamSSE(c, async (stream) => {
    const writer: SSEWriter = {
      async write(event, data, seqId) {
        await stream.writeSSE({ event, data, id: seqId });
      },
      close() {},
    };

    const unsubscribe = subscribe(session.tempId, writer);
    // Also subscribe to the real ID once it's resolved
    let unsubReal: (() => void) | null = null;
    const checkId = setInterval(() => {
      if (session.sessionId !== session.tempId && !unsubReal) {
        unsubReal = subscribe(session.sessionId, writer);
        unsubscribe(); // stop listening on temp ID
        clearInterval(checkId);
      }
    }, 100);

    stream.onAbort(() => {
      unsubscribe();
      unsubReal?.();
      clearInterval(checkId);
      // Do NOT stop the session — it keeps running
    });

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (session.status === "done" || session.status === "error") {
          clearInterval(check);
          resolve();
        }
      }, 1000);
      stream.onAbort(() => { clearInterval(check); resolve(); });
    });

    await stream.writeSSE({ event: "done", data: "{}", id: "done" });
  });
});

// ── Start ──

const server = Bun.serve({ fetch: app.fetch, port: PORT, hostname: HOST, idleTimeout: 255 });
console.log(`Agent harness listening on http://${HOST}:${PORT}${AUTH_TOKEN ? " (auth enabled)" : ""}`);

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  shutdownAll();
  server.stop();
  setTimeout(() => process.exit(0), 3000);
});
process.on("SIGINT", () => process.emit("SIGTERM"));
