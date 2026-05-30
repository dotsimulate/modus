import type { McpServerConfig } from "./profiles";

type ProxyTarget = {
  url: string;
  headers?: Record<string, string>;
};

const targets = new Map<string, ProxyTarget>();

function encodeProxyId(name: string, url: string): string {
  const bytes = new TextEncoder().encode(`${name}\0${url}\0${crypto.randomUUID()}`);
  return Buffer.from(bytes).toString("base64url");
}

export function registerMcpProxyTarget(name: string, config: Extract<McpServerConfig, { type: "http" | "sse" }>): string {
  const id = encodeProxyId(name, config.url);
  targets.set(id, { url: config.url, headers: config.headers });
  const port = Number(process.env.HARNESS_PORT ?? 3777);
  const token = process.env.HARNESS_TOKEN;
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
  return `http://127.0.0.1:${port}/api/mcp/proxy?id=${encodeURIComponent(id)}${tokenParam}`;
}

function isJsonRpcNotification(bodyText: string): boolean {
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return !("id" in parsed) && typeof parsed.method === "string";
  } catch {
    return false;
  }
}

function copyRequestHeaders(request: Request, target: ProxyTarget): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (
      lower === "host"
      || lower === "content-length"
      || lower === "connection"
      || lower === "accept-encoding"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  for (const [key, value] of Object.entries(target.headers ?? {})) {
    headers.set(key, value);
  }
  return headers;
}

function copyResponseHeaders(response: Response): Headers {
  const headers = new Headers();
  for (const [key, value] of response.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "connection") continue;
    headers.set(key, value);
  }
  return headers;
}

export async function handleMcpProxyRequest(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const id = requestUrl.searchParams.get("id");
  const target = id ? targets.get(id) : undefined;
  if (!target) return Response.json({ error: "unknown MCP proxy target" }, { status: 404 });

  const bodyText = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.text();

  const upstream = await fetch(target.url, {
    method: request.method,
    headers: copyRequestHeaders(request, target),
    body: bodyText,
  });

  const responseText = request.method === "HEAD" ? "" : await upstream.text();
  if (bodyText && isJsonRpcNotification(bodyText) && (responseText.trim() === "" || responseText.trim() === "null")) {
    return new Response(null, {
      status: 202,
      headers: copyResponseHeaders(upstream),
    });
  }

  return new Response(responseText, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream),
  });
}
