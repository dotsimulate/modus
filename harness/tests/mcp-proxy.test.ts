import { afterEach, expect, test } from "bun:test";
import { handleMcpProxyRequest, registerMcpProxyTarget } from "../mcp-proxy";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("MCP proxy normalizes null notification responses", async () => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = await request.text();
      if (body.includes("notifications/initialized")) {
        return new Response("null", {
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
    },
  });

  const proxyUrl = registerMcpProxyTarget("TD", {
    type: "http",
    url: `http://127.0.0.1:${server.port}/mcp`,
  });

  const response = await handleMcpProxyRequest(new Request(proxyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  }));

  expect(response.status).toBe(202);
  expect(await response.text()).toBe("");
});

test("MCP proxy URLs never embed the harness bearer token", () => {
  const prior = process.env.HARNESS_TOKEN;
  process.env.HARNESS_TOKEN = "mcp-proxy-token-canary";
  try {
    const proxyUrl = registerMcpProxyTarget("canary", {
      type: "http",
      url: "https://example.invalid/mcp",
    });
    expect(proxyUrl).not.toContain("mcp-proxy-token-canary");
    expect(new URL(proxyUrl).searchParams.has("token")).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.HARNESS_TOKEN;
    else process.env.HARNESS_TOKEN = prior;
  }
});
