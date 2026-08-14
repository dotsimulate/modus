/**
 * Provider-session credentials for the built-in Modus MCP endpoint.
 *
 * The supervisor bearer authorizes the whole harness. Provider children need
 * only the MCP bridge, so each provider process generation receives a random,
 * in-memory credential bound to one exact MCP route and then to its Modus
 * session. A resumed session mints a new credential with its new process.
 */

export const SESSION_MCP_CREDENTIAL_ENV_VAR = "MODUS_SESSION_MCP_TOKEN";
export const LEGACY_PROVIDER_MCP_BEARER_VAR = "MODUS_PROVIDER_MCP_LEGACY_BEARER";

const TOKEN_PREFIX = "mcp-session-";
const MCP_PATH = "/api/mcp/modus";

type SessionMcpCredential = {
  path: string;
  sessionId: string | null;
};

const credentials = new Map<string, SessionMcpCredential>();
const credentialsBySession = new Map<string, Set<string>>();

function enabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function legacyProviderMcpBearer(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!enabled(env[LEGACY_PROVIDER_MCP_BEARER_VAR])) return undefined;
  return env.HARNESS_TOKEN || undefined;
}

export function sessionMcpPath(scopeKey?: string): string {
  return scopeKey ? `${MCP_PATH}/${encodeURIComponent(scopeKey)}` : MCP_PATH;
}

/** Mint before provider spawn. Legacy mode deliberately restores the old bearer. */
export function mintSessionMcpCredential(scopeKey?: string): string | null {
  if (legacyProviderMcpBearer()) return null;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = TOKEN_PREFIX + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  credentials.set(token, { path: sessionMcpPath(scopeKey), sessionId: null });
  return token;
}

export function isSessionMcpCredential(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

/** Exact-route authorization; the credential is never valid as a general bearer. */
export function validateSessionMcpCredential(token: string, requestPath: string): boolean {
  const credential = credentials.get(token);
  return !!credential && credential.path === requestPath;
}

/** Bind a pre-spawn credential after provider initialization/rekey settles. */
export function bindSessionMcpCredential(sessionId: string, token: string): void {
  const credential = credentials.get(token);
  if (!credential) return;
  if (credential.sessionId && credential.sessionId !== sessionId) {
    const prior = credentialsBySession.get(credential.sessionId);
    prior?.delete(token);
    if (prior?.size === 0) credentialsBySession.delete(credential.sessionId);
  }
  credential.sessionId = sessionId;
  const tokens = credentialsBySession.get(sessionId) ?? new Set<string>();
  tokens.add(token);
  credentialsBySession.set(sessionId, tokens);
}

/** Keep ownership aligned when a provider replaces the provisional session id. */
export function rekeySessionMcpCredentials(oldSessionId: string, newSessionId: string): void {
  if (oldSessionId === newSessionId) return;
  const tokens = credentialsBySession.get(oldSessionId);
  if (!tokens) return;
  credentialsBySession.delete(oldSessionId);
  const next = credentialsBySession.get(newSessionId) ?? new Set<string>();
  for (const token of tokens) {
    const credential = credentials.get(token);
    if (credential) credential.sessionId = newSessionId;
    next.add(token);
  }
  credentialsBySession.set(newSessionId, next);
}

export function revokeSessionMcpCredential(token: string): void {
  const credential = credentials.get(token);
  if (!credential) return;
  credentials.delete(token);
  if (!credential.sessionId) return;
  const tokens = credentialsBySession.get(credential.sessionId);
  tokens?.delete(token);
  if (tokens?.size === 0) credentialsBySession.delete(credential.sessionId);
}

/** Revoke every provider generation still associated with a Modus session. */
export function revokeSessionMcpCredentials(sessionId: string): void {
  const tokens = credentialsBySession.get(sessionId);
  if (!tokens) return;
  credentialsBySession.delete(sessionId);
  for (const token of tokens) credentials.delete(token);
}
