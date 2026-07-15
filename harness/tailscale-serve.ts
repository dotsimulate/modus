export type TailscaleOwnership = {
  version: 1;
  dnsName: string;
  endpoint: string;
  proxy: string;
  targetPort: number;
  createdAt: string;
};

export type ServeEndpoint = {
  endpoint: string;
  proxy: string;
  targetPort: number;
  rootOnly: boolean;
  funnel: boolean;
};

export type ServeOwnershipClass = "none" | "modus" | "foreign";

export function parseOwnership(raw: string | null | undefined): TailscaleOwnership | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as TailscaleOwnership;
    if (value.version !== 1 || !value.dnsName || !value.endpoint || !value.proxy || !Number.isInteger(value.targetPort)) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseHttps443Endpoint(raw: string): ServeEndpoint | null {
  if (!raw.trim() || raw.trim() === "{}" || raw.trim() === "null") return null;
  let cfg: any;
  try { cfg = JSON.parse(raw); } catch { return null; }
  const web = cfg?.Web ?? {};
  const endpoints = Object.keys(web).filter((key) => key.endsWith(":443"));
  if (endpoints.length !== 1) return null;
  const endpoint = endpoints[0]!;
  const handlers = web[endpoint]?.Handlers ?? {};
  const paths = Object.keys(handlers);
  const proxy = typeof handlers["/"]?.Proxy === "string" ? handlers["/"].Proxy : "";
  const match = proxy.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)$/);
  return {
    endpoint,
    proxy,
    targetPort: match ? Number(match[1]) : 0,
    rootOnly: paths.length === 1 && paths[0] === "/" && !!match,
    funnel: Boolean(cfg?.AllowFunnel?.[endpoint]),
  };
}

export function classifyHttps443(raw: string, ownership: TailscaleOwnership | null): ServeOwnershipClass {
  if (!raw.trim() || raw.trim() === "{}" || raw.trim() === "null") return "none";
  try {
    const parsed = JSON.parse(raw);
    const endpoints = Object.keys(parsed?.Web ?? {}).filter((key) => key.endsWith(":443"));
    if (endpoints.length === 0) return "none";
    if (endpoints.length !== 1) return "foreign";
  } catch {
    return "foreign";
  }
  const endpoint = parseHttps443Endpoint(raw);
  if (!endpoint) return "foreign";
  if (!ownership || endpoint.funnel || !endpoint.rootOnly) return "foreign";
  return endpoint.endpoint === ownership.endpoint
    && endpoint.proxy === ownership.proxy
    && endpoint.targetPort === ownership.targetPort
    ? "modus"
    : "foreign";
}

export function canAdoptLegacyRule(
  raw: string,
  requestedPort: number,
  remotePersisted: boolean,
  basePort: number,
  scanRange: number,
): boolean {
  if (!remotePersisted) return false;
  const endpoint = parseHttps443Endpoint(raw);
  if (!endpoint || endpoint.funnel || !endpoint.rootOnly || endpoint.targetPort !== requestedPort) return false;
  return endpoint.targetPort >= basePort && endpoint.targetPort < basePort + scanRange;
}

export function ownershipFor(dnsName: string, targetPort: number, now = new Date()): TailscaleOwnership {
  const cleanDns = dnsName.replace(/\.$/, "");
  return {
    version: 1,
    dnsName: cleanDns,
    endpoint: `${cleanDns}:443`,
    proxy: `http://127.0.0.1:${targetPort}`,
    targetPort,
    createdAt: now.toISOString(),
  };
}

export function tailscaleServeOnArgs(port: number): string[] {
  return ["serve", "--bg", "--yes", String(port)];
}

export function tailscaleServeOffArgs(): string[] {
  return ["serve", "--https=443", "off"];
}
