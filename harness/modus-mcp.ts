/**
 * Modus MCP Server — serves `modus_submit` as a Streamable HTTP MCP endpoint.
 *
 * One tool, three token types:
 *   - Move tokens  → route to move-runner handleSubmit()
 *   - Mission tokens (prefix "mis-") → route to mission-runner handleMissionCommand()
 *   - API tokens (prefix "api-") → route to registered API handlers
 *
 * Token type discrimination happens here. The model sees one tool surface.
 *
 * The harness serves this at /api/mcp/modus. Sessions that need move/mission
 * support include it in their MCP server config (via global config or profile).
 *
 * Uses the web-standard Streamable HTTP transport, compatible with Hono/Bun.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { handleSubmit } from "./move-runner";
import { isMissionToken, handleMissionCommand } from "./mission-runner";
import { addSessionTag, getSession } from "./db";
import { broadcastUiEvent } from "./session-manager";
import { join } from "path";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";

/**
 * Handle an incoming MCP request from Hono.
 *
 * Stateless mode: each request gets a fresh server + transport pair.
 * This is fine because modus_submit is synchronous request/response —
 * no server-initiated notifications, no long-lived connections needed.
 */
export async function handleModusMcpRequest(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  const server = new McpServer(
    { name: "modus", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.tool(
    "modus_submit",
    "Submit structured data for the active move or mission. The token identifies which contract this submission is for. For moves, data is the structured output. For missions, data must include an 'op' field (read, delegate, report, gate, pause).",
    {
      token: z.string().describe("The contract token provided in the move/mission prompt"),
      data: z.union([
        z.record(z.string(), z.unknown()),
        z.string(),
      ]).optional().describe("Structured payload (object or JSON string) — move schema output or mission command with 'op' field"),
    },
    async (params) => {
      const { token, data: rawData, ...rest } = params as Record<string, unknown> & { token: string; data?: unknown };

      // Three calling patterns:
      // 1. data is an object (native MCP clients)
      // 2. data is a JSON string (Claude Code XML serialization)
      // 3. data is absent, fields passed flat (haiku/smaller models)
      let data: Record<string, unknown>;
      if (rawData == null) {
        // Flat params — everything except token IS the data
        data = rest;
      } else if (typeof rawData === "string") {
        try {
          const parsed = JSON.parse(rawData);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { content: [{ type: "text" as const, text: "data must be a JSON object, not an array or primitive" }], isError: true };
          }
          data = parsed;
        } catch {
          return { content: [{ type: "text" as const, text: `data is not valid JSON: ${rawData.slice(0, 200)}` }], isError: true };
        }
      } else {
        data = rawData as Record<string, unknown>;
      }
      // ── Route by token type ──
      if (isApiToken(token)) {
        return handleApiSubmit(token, data as Record<string, unknown>);
      }
      if (isMissionToken(token)) {
        return handleMissionSubmit(token, data as Record<string, unknown>);
      }
      return handleMoveSubmit(token, data as Record<string, unknown>);
    },
  );

  await server.connect(transport);
  return transport.handleRequest(request);
}

// ── Move token handler (existing behavior) ──

async function handleMoveSubmit(token: string, data: Record<string, unknown>) {
  const result = await handleSubmit(token, data);

  if (result.ok) {
    return {
      content: [{
        type: "text" as const,
        text: result.message ?? "Move completed successfully.",
      }],
    };
  }

  if (result.retry) {
    return {
      content: [{
        type: "text" as const,
        text: `Submission invalid — please fix and retry:\n${result.error}`,
      }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `Move submission failed: ${result.error}`,
    }],
    isError: true,
  };
}

// ── API token infrastructure ──

type ApiHandler = (sessionId: string, data: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; error?: string }>;

const apiHandlers = new Map<string, ApiHandler>();

/** Register an API handler by name */
export function registerApiHandler(name: string, handler: ApiHandler) {
  apiHandlers.set(name, handler);
}

/**
 * API tokens encode the session ID so the model never needs to know it.
 * Format: "api-<sessionId>-<random>"
 */
const API_PREFIX = "api-";

function isApiToken(token: string): boolean {
  return token.startsWith(API_PREFIX);
}

/** Create an API token for a session. The model receives this opaque string. */
export function createApiToken(sessionId: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
  return `${API_PREFIX}${sessionId}-${rand}`;
}

/** Extract the session ID from an API token */
function parseApiToken(token: string): string | null {
  if (!token.startsWith(API_PREFIX)) return null;
  const rest = token.slice(API_PREFIX.length);
  // Session ID is everything before the last "-<random>" segment (12 chars)
  const lastDash = rest.lastIndexOf("-");
  if (lastDash < 1) return null;
  return rest.slice(0, lastDash);
}

async function handleApiSubmit(token: string, data: Record<string, unknown>) {
  const sessionId = parseApiToken(token);
  if (!sessionId) {
    return {
      content: [{ type: "text" as const, text: "Invalid API token format" }],
      isError: true,
    };
  }

  const op = data.op;
  if (typeof op !== "string") {
    return {
      content: [{ type: "text" as const, text: "API call requires an 'op' field (string)" }],
      isError: true,
    };
  }

  const handler = apiHandlers.get(op);
  if (!handler) {
    return {
      content: [{ type: "text" as const, text: `Unknown API operation: ${op}` }],
      isError: true,
    };
  }

  const result = await handler(sessionId, data);
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: result.message ?? "OK" }],
    };
  }
  return {
    content: [{ type: "text" as const, text: `API error: ${result.error}` }],
    isError: true,
  };
}

// ── Built-in API handlers ──

registerApiHandler("tag-session", async (sessionId, data) => {
  const tag = data.tag;
  if (typeof tag !== "string" || tag.length === 0) {
    return { ok: false, error: "Missing or empty 'tag' field" };
  }
  addSessionTag(sessionId, tag);
  return { ok: true, message: `Tagged session with "${tag}"` };
});

registerApiHandler("open-file", async (sessionId, data) => {
  const path = data.path;
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, error: "Missing or empty 'path' field" };
  }
  broadcastUiEvent(sessionId, { type: "ui", action: "open-file", path });
  return { ok: true, message: `Opened file: ${path}` };
});

// ── Notes API handlers ──
// Agents can create and read notes in the project's .modus/notes/ directory.

function getSessionCwd(sessionId: string): string | null {
  const row = getSession(sessionId);
  return row?.cwd ?? null;
}

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
    let val: any = line.slice(colon + 1).trim();
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

registerApiHandler("list-notes", async (sessionId) => {
  const cwd = getSessionCwd(sessionId);
  if (!cwd) return { ok: false, error: "Session has no CWD" };
  const dir = notesDir(cwd);
  try {
    const files = await readdir(dir);
    const notes = await Promise.all(
      files.filter((f) => f.endsWith(".md")).map(async (f) => {
        const raw = await readFile(join(dir, f), "utf-8");
        const { meta, body } = parseNoteFrontmatter(raw);
        return { id: f.replace(/\.md$/, ""), title: meta.title || f, preview: body.slice(0, 100) };
      })
    );
    return { ok: true, message: JSON.stringify(notes) };
  } catch (err: any) {
    if (err.code === "ENOENT") return { ok: true, message: "[]" };
    return { ok: false, error: err.message };
  }
});

registerApiHandler("read-note", async (sessionId, data) => {
  const cwd = getSessionCwd(sessionId);
  if (!cwd) return { ok: false, error: "Session has no CWD" };
  const id = data.id;
  if (typeof id !== "string") return { ok: false, error: "Missing 'id' field" };
  try {
    const raw = await readFile(join(notesDir(cwd), `${id}.md`), "utf-8");
    const { meta, body } = parseNoteFrontmatter(raw);
    return { ok: true, message: JSON.stringify({ id, ...meta, content: body }) };
  } catch (err: any) {
    return { ok: false, error: err.code === "ENOENT" ? "Note not found" : err.message };
  }
});

registerApiHandler("create-note", async (sessionId, data) => {
  const cwd = getSessionCwd(sessionId);
  if (!cwd) return { ok: false, error: "Session has no CWD" };
  const title = typeof data.title === "string" ? data.title : "untitled";
  const content = typeof data.content === "string" ? data.content : "";
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const now = new Date().toISOString();
  const id = `${now.slice(0, 10)}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "").slice(0, 40)}-${Date.now().toString(36)}`;
  const dir = notesDir(cwd);
  await mkdir(dir, { recursive: true });
  const meta = { title, created: now, updated: now, tags };
  await writeFile(join(dir, `${id}.md`), buildNoteFrontmatter(meta) + content, "utf-8");
  return { ok: true, message: `Note created: ${id}` };
});

// ── Mission token handler (command bus) ──

async function handleMissionSubmit(token: string, data: Record<string, unknown>) {
  const result = await handleMissionCommand(token, data);

  if (result.ok) {
    // Build response text from result + message
    const parts: string[] = [];
    if (result.message) parts.push(result.message);
    if (result.result) parts.push("```json\n" + JSON.stringify(result.result, null, 2) + "\n```");
    return {
      content: [{
        type: "text" as const,
        text: parts.length > 0 ? parts.join("\n\n") : "OK",
      }],
    };
  }

  return {
    content: [{
      type: "text" as const,
      text: `Mission command failed: ${result.error}`,
    }],
    isError: true,
  };
}
