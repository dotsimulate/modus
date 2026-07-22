export const PIN_FAILURE_LIMIT = 5;
export const PIN_FAILURE_WINDOW_MS = 5 * 60_000;
export const PIN_COOLDOWN_MS = 15 * 60_000;
export const PIN_GLOBAL_FAILURE_LIMIT = 50;

type OriginOptions = {
  port: number;
  requestHost?: string | null;
  configuredOrigins?: string | null;
};

function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol === "tauri:") {
      if (url.hostname !== "localhost" || url.port || url.username || url.password) return null;
      if (url.pathname !== "/" && url.pathname !== "" || url.search || url.hash) return null;
      return "tauri://localhost";
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function configuredOriginSet(value?: string | null): Set<string> {
  return new Set((value ?? "")
    .split(",")
    .map((entry) => normalizeOrigin(entry.trim()))
    .filter((entry): entry is string => !!entry));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

function hostWithoutDefaultPort(host: string): string {
  return host.toLowerCase().replace(/:80$/, "").replace(/:443$/, "");
}

/** Browser origins accepted by the local UI/API boundary. Requests without an
 * Origin header are handled separately so CLI and SDK clients remain valid. */
export function isAllowedBrowserOrigin(origin: string, options: OriginOptions): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (configuredOriginSet(options.configuredOrigins).has(normalized)) return true;

  const url = new URL(normalized);
  const hostname = url.hostname.toLowerCase();
  const effectivePort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const requestHost = hostWithoutDefaultPort(options.requestHost ?? "");
  const originHost = hostWithoutDefaultPort(url.host);
  const sameRequestHost = !!requestHost && requestHost === originHost;

  if (url.protocol === "tauri:" && hostname === "localhost" && !url.port) return true;
  if ((url.protocol === "http:" || url.protocol === "https:") && hostname === "tauri.localhost" && !url.port) return true;

  if (isLoopback(hostname)) {
    return effectivePort === options.port || effectivePort === 5173 || effectivePort === 5174 || effectivePort === 5180;
  }
  if (url.protocol === "https:" && hostname.endsWith(".ts.net") && effectivePort === 443) {
    return sameRequestHost;
  }
  if (url.protocol === "http:" && effectivePort === options.port && (isPrivateIpv4(hostname) || hostname.endsWith(".local"))) {
    return sameRequestHost;
  }
  return false;
}

export function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function requestSourceKey(peerAddress: string | null | undefined, forwardedFor?: string | null): string {
  const peer = (peerAddress ?? "unknown").replace(/^::ffff:/, "");
  if (!isLoopbackAddress(peer) || !forwardedFor) return peer;
  const forwarded = forwardedFor.split(",")[0]?.trim();
  return forwarded || peer;
}

type FailureState = { failures: number[]; blockedUntil: number };

export type ThrottleDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class PinAttemptThrottle {
  private readonly sources = new Map<string, FailureState>();
  private readonly global: FailureState = { failures: [], blockedUntil: 0 };

  constructor(
    private readonly failureLimit = PIN_FAILURE_LIMIT,
    private readonly windowMs = PIN_FAILURE_WINDOW_MS,
    private readonly cooldownMs = PIN_COOLDOWN_MS,
    private readonly globalFailureLimit = PIN_GLOBAL_FAILURE_LIMIT,
  ) {}

  private prune(state: FailureState, now: number): void {
    state.failures = state.failures.filter((time) => now - time < this.windowMs);
    if (state.blockedUntil <= now) state.blockedUntil = 0;
  }

  private pruneSources(now: number): void {
    for (const [source, state] of this.sources) {
      this.prune(state, now);
      if (state.failures.length === 0 && state.blockedUntil === 0) this.sources.delete(source);
    }
  }

  check(source: string, now = Date.now()): ThrottleDecision {
    this.pruneSources(now);
    this.prune(this.global, now);
    const state = this.sources.get(source);
    const blockedUntil = Math.max(state?.blockedUntil ?? 0, this.global.blockedUntil);
    if (blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
    }
    return { allowed: true };
  }

  recordFailure(source: string, now = Date.now()): ThrottleDecision {
    this.pruneSources(now);
    const state = this.sources.get(source) ?? { failures: [], blockedUntil: 0 };
    this.prune(state, now);
    this.prune(this.global, now);
    state.failures.push(now);
    this.global.failures.push(now);
    if (state.failures.length >= this.failureLimit) state.blockedUntil = now + this.cooldownMs;
    if (this.global.failures.length >= this.globalFailureLimit) this.global.blockedUntil = now + this.cooldownMs;
    this.sources.set(source, state);
    return this.check(source, now);
  }

  recordSuccess(source: string): void {
    this.sources.delete(source);
  }
}
