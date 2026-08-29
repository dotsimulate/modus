/**
 * MCP Bridge — connects MCP servers to PI's tool system.
 *
 * Reads mcpServers from profile config, launches MCP clients via
 * @modelcontextprotocol/sdk, and wraps each tool as a PI ToolDefinition.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { ToolDefinition, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { McpServerConfig } from "../profiles";
import { resolveSecret } from "../secrets";
import { providerChildEnv } from "./child-env";
import { logProviderDiagnostic } from "./provider-diagnostics";

export type McpConnection = {
  name: string;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
};

/**
 * Start all MCP server connections from a profile's mcpServers config.
 * Returns the live connections (for shutdown) and wrapped PI tool definitions.
 */
export async function startMcpServers(
  mcpServers: Record<string, McpServerConfig>,
): Promise<{ connections: McpConnection[]; tools: ToolDefinition[] }> {
  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    try {
      const conn = await connectMcpServer(name, config);
      connections.push(conn);

      const { tools: serverTools } = await conn.client.listTools();
      for (const tool of serverTools) {
        tools.push(wrapMcpTool(name, conn.client, tool));
      }

      logProviderDiagnostic(`[mcp-bridge] ${name}: connected, ${serverTools.length} tool(s)`);
    } catch (err) {
      console.error(`[mcp-bridge] ${name}: failed to connect —`, err);
    }
  }

  return { connections, tools };
}

/**
 * Shut down all MCP connections.
 */
export async function stopMcpServers(connections: McpConnection[]): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.transport.close();
    } catch {
      // best effort
    }
  }
}

// ── Internals ──

async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpConnection> {
  const client = new Client({ name: `harness-${name}`, version: "1.0.0" });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;

  if ("command" in config) {
    // stdio transport
    const env: Record<string, string> = providerChildEnv();
    if (config.env) {
      for (const [k, v] of Object.entries(config.env)) {
        // Resolve $VAR_NAME references in env values
        env[k] = v.startsWith("$") ? (resolveSecret(v.slice(1)) ?? v) : v;
      }
    }
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
    });
  } else if (config.type === "http") {
    transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      { requestInit: config.headers ? { headers: config.headers } : undefined },
    );
  } else {
    // SSE — deprecated, use StreamableHTTP as fallback
    transport = new StreamableHTTPClientTransport(
      new URL(config.url),
      { requestInit: config.headers ? { headers: config.headers } : undefined },
    );
  }

  await client.connect(transport);
  return { name, client, transport };
}

function wrapMcpTool(
  serverName: string,
  client: Client,
  mcpTool: { name: string; description?: string; inputSchema?: any },
): ToolDefinition {
  // Convert MCP JSON Schema to TypeBox via Type.Unsafe
  const parameters: TSchema = mcpTool.inputSchema
    ? Type.Unsafe<Record<string, unknown>>(mcpTool.inputSchema)
    : Type.Object({});

  return {
    name: `mcp__${serverName}__${mcpTool.name}`,
    label: `${serverName}: ${mcpTool.name}`,
    description: mcpTool.description ?? `MCP tool ${mcpTool.name} from ${serverName}`,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: params as Record<string, unknown>,
      });

      // Map MCP result content to PI format
      const content: AgentToolResult<unknown>["content"] = [];
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === "text") {
            content.push({ type: "text", text: block.text as string });
          } else if (block.type === "image") {
            content.push({
              type: "image",
              data: (block as any).data,
              mimeType: (block as any).mimeType ?? "image/png",
            });
          }
        }
      }

      if (content.length === 0) {
        content.push({ type: "text", text: JSON.stringify(result.content ?? result) });
      }

      return { content, details: { serverName, toolName: mcpTool.name } };
    },
  };
}
