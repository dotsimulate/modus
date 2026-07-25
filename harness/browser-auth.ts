export const DEFAULT_BROWSER_SESSION_IDLE_MS = 24 * 60 * 60_000;
export const DEFAULT_BROWSER_SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60_000;

type BrowserSession = {
  issuedAt: number;
  lastSeenAt: number;
};

export type MintedBrowserSession = {
  token: string;
  expiresAt: number;
};

/**
 * In-memory browser sessions intentionally die with the backend process.
 * Validation enforces both a sliding idle limit and a non-sliding absolute
 * limit so a copied browser token cannot remain valid indefinitely.
 */
export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly connections = new Map<string, Set<() => void>>();
  private readonly revocationListeners = new Set<(tokens: readonly string[]) => void>();

  constructor(
    private readonly idleMs = DEFAULT_BROWSER_SESSION_IDLE_MS,
    private readonly absoluteMs = DEFAULT_BROWSER_SESSION_ABSOLUTE_MS,
    private readonly createToken: () => string = () => crypto.randomUUID(),
  ) {
    if (idleMs <= 0 || absoluteMs <= 0) throw new Error("browser session limits must be positive");
  }

  mint(now = Date.now()): MintedBrowserSession {
    const token = this.createToken();
    this.sessions.set(token, { issuedAt: now, lastSeenAt: now });
    return { token, expiresAt: now + this.absoluteMs };
  }

  validate(token: string, now = Date.now(), touch = true): boolean {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (now - session.lastSeenAt >= this.idleMs || now - session.issuedAt >= this.absoluteMs) {
      this.revokeTokens([token]);
      return false;
    }
    if (touch) session.lastSeenAt = now;
    return true;
  }

  revokeAll(): void {
    this.revokeTokens([...this.sessions.keys()]);
  }

  registerConnection(token: string, close: () => void): () => void {
    if (!this.validate(token, Date.now(), false)) {
      close();
      return () => {};
    }
    const connections = this.connections.get(token) ?? new Set<() => void>();
    connections.add(close);
    this.connections.set(token, connections);
    return () => {
      connections.delete(close);
      if (connections.size === 0) this.connections.delete(token);
    };
  }

  onRevoke(listener: (tokens: readonly string[]) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private revokeTokens(tokens: string[]): void {
    const revoked = tokens.filter((token) => this.sessions.delete(token));
    if (revoked.length === 0) return;
    for (const token of revoked) {
      const connections = this.connections.get(token);
      this.connections.delete(token);
      for (const close of connections ?? []) {
        try { close(); } catch { /* one broken connection cannot block revocation */ }
      }
    }
    for (const listener of this.revocationListeners) {
      try { listener(revoked); } catch { /* transport cleanup is best-effort after token invalidation */ }
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
