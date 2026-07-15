/**
 * A turn-scoped MCP fan-in server for Antigravity CLI.
 *
 * Antigravity loads this server from the Modus provider plugin. The parent
 * provider supplies a temporary config path through the environment, allowing
 * each concurrent Modus session to expose its own MCP servers without editing
 * the user's Antigravity MCP configuration.
 */

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

type McpConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "sse" | "http"; url: string; headers?: Record<string, string> };

type Connection = {
  client: Client;
  transport: SSEClientTransport | StdioClientTransport | StreamableHTTPClientTransport;
};

type RoutedTool = {
  client: Client;
  originalName: string;
};

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

async function connect(name: string, config: McpConfig): Promise<Connection> {
  const client = new Client({ name: `modus-antigravity-${safeSegment(name)}`, version: "1.0.0" });
  const transport = "command" in config
    ? new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
      })
    : config.type === "sse"
      ? new SSEClientTransport(
          new URL(config.url),
          config.headers ? {
            eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: config.headers }) },
            requestInit: { headers: config.headers },
          } : undefined,
        )
      : new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: config.headers ? { headers: config.headers } : undefined },
      );
  await client.connect(transport);
  return { client, transport };
}

const configPath = process.env.MODUS_ANTIGRAVITY_MCP_CONFIG_PATH;
let configs: Record<string, McpConfig> = {};
if (configPath) {
  try {
    configs = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`[modus-antigravity-mcp] Could not read ${configPath}:`, error);
  }
}

const connections: Connection[] = [];
const exposedTools: Array<Record<string, unknown>> = [];
const routes = new Map<string, RoutedTool>();

for (const [serverName, config] of Object.entries(configs)) {
  try {
    const connection = await connect(serverName, config);
    connections.push(connection);
    let cursor: string | undefined;
    do {
      const response = await connection.client.listTools(cursor ? { cursor } : undefined);
      for (const tool of response.tools) {
        const base = `${safeSegment(serverName)}__${safeSegment(tool.name)}`;
        let exposedName = base;
        let suffix = 2;
        while (routes.has(exposedName)) exposedName = `${base}_${suffix++}`;
        routes.set(exposedName, { client: connection.client, originalName: tool.name });
        exposedTools.push({
          ...tool,
          name: exposedName,
          description: `[${serverName}] ${tool.description ?? tool.name}`,
        });
      }
      cursor = response.nextCursor;
    } while (cursor);
  } catch (error) {
    console.error(`[modus-antigravity-mcp] ${serverName} failed:`, error);
  }
}

const server = new Server(
  { name: "modus-antigravity-profile-tools", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools as any[] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const route = routes.get(request.params.name);
  if (!route) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown Modus MCP tool: ${request.params.name}` }],
    };
  }
  return await route.client.callTool({
    name: route.originalName,
    arguments: request.params.arguments ?? {},
  }) as any;
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const connection of connections) {
    try { await connection.transport.close(); } catch { /* best effort */ }
  }
}

process.once("SIGINT", () => { void close().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void close().finally(() => process.exit(0)); });

const stdio = new StdioServerTransport();
stdio.onclose = () => { void close(); };
await server.connect(stdio);
