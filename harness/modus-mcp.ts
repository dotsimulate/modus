/**
 * Modus MCP Server — serves `modus_submit` as a Streamable HTTP MCP endpoint.
 *
 * One tool, two token types:
 *   - Move tokens  → route to move-runner handleSubmit()
 *   - Mission tokens (prefix "mis-") → route to mission-runner handleMissionCommand()
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
      data: z.record(z.string(), z.unknown()).describe("Structured payload — move schema output or mission command with 'op' field"),
    },
    async ({ token, data }) => {
      // ── Route by token type ──
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
