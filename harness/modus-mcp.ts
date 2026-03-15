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
import { addSessionTag } from "./db";

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
