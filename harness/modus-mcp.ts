/**
 * Modus MCP Server — serves `modus_submit` as a Streamable HTTP MCP endpoint.
 *
 * One tool, four token types:
 *   - Move tokens  → route to move-runner handleSubmit()
 *   - Move API tokens (prefix "mapi-") → route to move API handlers
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
import { handleSubmit, isMoveApiToken, handleMoveApiSubmit } from "./move-runner";
import { isMissionToken, handleMissionCommand } from "./mission-runner";
import { addSessionTag, getSession } from "./db";
import { broadcastUiEvent } from "./session-manager";
import { buildHarnessContext, type HarnessContext } from "./harness-context";
import { getScopedSkill, getScopedSkills } from "./skill-attachment";
import { buildSkillPayload } from "./skills";
import { join } from "path";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";

/**
 * Handle an incoming MCP request from Hono.
 *
 * Stateless mode: each request gets a fresh server + transport pair.
 * This is fine because modus_submit is synchronous request/response —
 * no server-initiated notifications, no long-lived connections needed.
 *
 * `scopeKey` comes from the URL path suffix and identifies the calling
 * session's attached skills. Because the server is rebuilt per request, the
 * skill tools are simply a registration branch: sessions with no attached
 * skills never see them at all.
 */
export async function handleModusMcpRequest(request: Request, scopeKey?: string): Promise<Response> {
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
    "Submit a command to the harness. Provide the token you were given and a data object for the operation.",
    {
      token: z.string().describe("The token you received"),
      data: z.string().optional().describe("Operation payload as a JSON string"),
    },
    async (params) => {
      const { token, data: rawData, ...rest } = params as Record<string, unknown> & { token: string; data?: unknown };

      // Three calling patterns:
      // 1. data is an object (native MCP clients, most models)
      // 2. data is a JSON string (Claude Code XML serialization — handled here, not in schema)
      // 3. data is absent, fields passed flat (haiku/smaller models)
      // Schema is plain object (no union/oneOf) to avoid llama.cpp autoparser PEG bugs.
      let data: Record<string, unknown>;
      if (rawData == null) {
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
      if (isMoveApiToken(token)) {
        return handleMoveApiSubmitMcp(token, data as Record<string, unknown>);
      }
      if (isApiToken(token)) {
        return handleApiSubmit(token, data as Record<string, unknown>);
      }
      if (isMissionToken(token)) {
        return handleMissionSubmit(token, data as Record<string, unknown>);
      }
      return handleMoveSubmit(token, data as Record<string, unknown>);
    },
  );

  registerSkillTools(server, scopeKey);

  await server.connect(transport);
  return transport.handleRequest(request);
}

// ── Skill tools (registered only for sessions that attached skills) ──

/**
 * Skills are a read, not a submit, so they get their own tools rather than
 * widening `modus_submit`. There is no token: the tools return user-installed
 * text and mutate nothing, and the scope key in the URL already says which
 * skills the caller may see.
 */
function registerSkillTools(server: McpServer, scopeKey?: string): void {
  if (!scopeKey) return;
  const attached = getScopedSkills(scopeKey);
  if (!attached || attached.length === 0) return;

  server.tool(
    "skills_list",
    "List the skills attached to this session. Returns each skill's name and description only — call skills_load to read one.",
    {},
    async () => {
      const listing = (getScopedSkills(scopeKey) ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(listing, null, 2) }] };
    },
  );

  server.tool(
    "skills_load",
    "Load an attached skill's full instructions. Returns the SKILL.md text and the directory it lives in, so any files it references can be read with ordinary file tools.",
    { name: z.string().describe("Skill name, as returned by skills_list") },
    async ({ name }) => {
      const skill = getScopedSkill(scopeKey, name);
      if (!skill) {
        const available = (getScopedSkills(scopeKey) ?? []).map((s) => s.name).join(", ");
        return {
          content: [{ type: "text" as const, text: `No skill named "${name}" is attached. Available: ${available || "(none)"}` }],
          isError: true,
        };
      }
      // Same payload shape the composer injects and other harnesses emit —
      // frontmatter stripped, `Base Path:` leading. See buildSkillPayload.
      const text = buildSkillPayload(skill);
      if (text === null) {
        return {
          content: [{ type: "text" as const, text: `Skill "${name}" could not be read from ${skill.path}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text }] };
    },
  );
}

// ── Move API token handler (multi-submit, stateful) ──

async function handleMoveApiSubmitMcp(token: string, data: Record<string, unknown>) {
  const result = await handleMoveApiSubmit(token, data, "agent");
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: result.message ?? "OK" }],
    };
  }
  return {
    content: [{ type: "text" as const, text: result.error ?? "Unknown error" }],
    isError: true,
  };
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

/** New-shape api-handler op: receives the full Harness Context instead of a bare sessionId. */
type OpHandler = (ctx: HarnessContext, data: Record<string, unknown>) => Promise<{ ok: boolean; message?: string; error?: string }>;

/** Adapt a new-shape op (ctx, data) into the uniform (sessionId, data) registry entry,
 *  building a Harness Context per call. Project-local handlers default to "reviewed" trust. */
function wrapOpHandler(op: string, fn: OpHandler, cwd: string): ApiHandler {
  return async (sessionId, data) => {
    const ctx = buildHarnessContext({
      kind: "api-handler",
      name: op,
      sessionId: sessionId || null,
      caller: "agent",
      cwd,
      userProfile: getSession(sessionId)?.user_profile ?? undefined,
      trust: "reviewed",
    });
    return fn(ctx, data);
  };
}

const apiHandlers = new Map<string, ApiHandler>();

/** Register an API handler by name */
export function registerApiHandler(name: string, handler: ApiHandler) {
  apiHandlers.set(name, handler);
}

const API_PREFIX = "api-";

/** Short token → sessionId registry. Tokens are session-scoped and in-memory only. */
const tokenRegistry = new Map<string, string>();

function isApiToken(token: string): boolean {
  return token.startsWith(API_PREFIX);
}

/** Create a short opaque API token for a session. The session ID is never exposed to the model. */
export function createApiToken(sessionId: string): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);
  const token = `${API_PREFIX}${rand}`;
  tokenRegistry.set(token, sessionId);
  return token;
}

/** Resolve an API token to its session ID. */
function parseApiToken(token: string): string | null {
  return tokenRegistry.get(token) ?? null;
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

  let handler = apiHandlers.get(op);

  // Lazy-load from project-local .modus/api-handlers/ if not in global registry
  if (!handler) {
    const cwd = getSessionCwd(sessionId);
    if (cwd) {
      handler = await loadProjectHandler(cwd, op);
    }
  }

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

// ── Project-local API handler lazy-loader ──

/** Cache: cwd → Map<opName, handler>. Busted by reload-handlers op. */
const projectHandlerCache = new Map<string, Map<string, ApiHandler>>();

async function loadProjectHandler(cwd: string, op: string): Promise<ApiHandler | undefined> {
  // Check cache first
  const cached = projectHandlerCache.get(cwd);
  if (cached) return cached.get(op);

  // Scan .modus/api-handlers/*.ts
  const handlersDir = join(cwd, ".modus", "api-handlers");
  let files: string[];
  try {
    files = (await readdir(handlersDir)).filter(f => f.endsWith(".ts"));
  } catch {
    return undefined;
  }

  const cwdHandlers = new Map<string, ApiHandler>();

  for (const file of files) {
    const filePath = join(handlersDir, file);
    try {
      const mod = await import(filePath);
      // Three export shapes, disambiguated by export KEY (never by arity — both
      // (sessionId, data) and (ctx, data) have length 2, so arity cannot distinguish):
      //   - `ops`      → NEW (ctx: HarnessContext, data) — full capability context
      //   - `handlers` → OLD (sessionId, data)
      //   - named fns  → OLD (sessionId, data), kebab-cased — only when no ops/handlers
      let matched = false;
      if (mod.ops && typeof mod.ops === "object") {
        for (const [name, fn] of Object.entries(mod.ops)) {
          if (typeof fn === "function") cwdHandlers.set(name, wrapOpHandler(name, fn as OpHandler, cwd));
        }
        matched = true;
      }
      if (mod.handlers && typeof mod.handlers === "object") {
        for (const [name, fn] of Object.entries(mod.handlers)) {
          if (typeof fn === "function") cwdHandlers.set(name, fn as ApiHandler);
        }
        matched = true;
      }
      if (!matched) {
        for (const [name, fn] of Object.entries(mod)) {
          if (typeof fn === "function" && name !== "default") {
            // Convert camelCase/snake_case export names to kebab-case op names
            const opName = name.replace(/([a-z])([A-Z])/g, "$1-$2").replace(/_/g, "-").toLowerCase();
            cwdHandlers.set(opName, fn as ApiHandler);
          }
        }
      }
    } catch (err) {
      console.error(`[modus] Failed to load API handler ${file}:`, err);
    }
  }

  projectHandlerCache.set(cwd, cwdHandlers);
  return cwdHandlers.get(op);
}

registerApiHandler("reload-handlers", async (sessionId) => {
  const cwd = getSessionCwd(sessionId);
  if (!cwd) return { ok: false, error: "Session has no CWD" };
  projectHandlerCache.delete(cwd);
  return { ok: true, message: "Project API handler cache cleared. Next API call will re-scan." };
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
