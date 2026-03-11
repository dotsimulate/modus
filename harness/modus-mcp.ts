/**
 * Modus MCP Server — serves `modus_submit` as a Streamable HTTP MCP endpoint.
 *
 * This is the stable bridge tool that agents use to submit structured data
 * for active moves. One tool, one purpose — contract identification via token.
 *
 * The harness serves this at /api/mcp/modus. Sessions that need move support
 * include it in their MCP server config (via global config or profile).
 *
 * Uses the web-standard Streamable HTTP transport, compatible with Hono/Bun.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { handleSubmit } from "./move-runner";

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
    "Submit structured data for the active move. The token identifies which move contract this submission is for.",
    {
      token: z.string().describe("The move contract token provided in the move prompt"),
      data: z.record(z.string(), z.unknown()).describe("Structured output matching the move's schema"),
    },
    async ({ token, data }) => {
      const result = await handleSubmit(token, data as Record<string, unknown>);

      if (result.ok) {
        return {
          content: [{
            type: "text" as const,
            text: result.message ?? "Move completed successfully.",
          }],
        };
      }

      // Validation failure with retry
      if (result.retry) {
        return {
          content: [{
            type: "text" as const,
            text: `Submission invalid — please fix and retry:\n${result.error}`,
          }],
          isError: true,
        };
      }

      // Terminal error
      return {
        content: [{
          type: "text" as const,
          text: `Move submission failed: ${result.error}`,
        }],
        isError: true,
      };
    },
  );

  await server.connect(transport);
  return transport.handleRequest(request);
}
