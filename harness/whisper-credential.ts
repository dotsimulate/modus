/**
 * Whisper upstream credential policy.
 *
 * The transcription endpoint is user-configurable, and so is the name of the
 * secret holding its API key. The key itself is deliberately never sent to the
 * browser: client-extension settings are stored in the user profile UI config
 * and returned verbatim by GET /api/client-extensions, so a plain apiKey
 * setting would be readable by any client that can list extensions. The browser
 * names the secret; the harness resolves it and attaches it here.
 *
 * Because the destination is also user-configurable, the credential is only
 * attached to transports that cannot expose it in the clear — TLS, or a
 * loopback address that never leaves the machine.
 */

export type WhisperCredentialDecision =
  | { kind: "none" }
  | { kind: "attach"; authorization: string }
  | { kind: "reject"; error: string };

export function isLoopbackHostname(hostname: string): boolean {
  // URL.hostname keeps IPv6 literals bracketed.
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolveWhisperCredential(input: {
  secretName?: string;
  targetUrl: string;
  lookup: (name: string) => string | undefined;
}): WhisperCredentialDecision {
  const secretName = input.secretName?.trim();
  if (!secretName) return { kind: "none" };

  const apiKey = input.lookup(secretName);
  if (!apiKey) {
    return { kind: "reject", error: `whisper secret "${secretName}" is not configured` };
  }

  let target: URL;
  try {
    target = new URL(input.targetUrl);
  } catch {
    return { kind: "reject", error: "invalid whisper url" };
  }
  if (target.protocol !== "https:" && !isLoopbackHostname(target.hostname)) {
    return {
      kind: "reject",
      error: "refusing to send the whisper key to a non-https, non-local endpoint",
    };
  }

  return { kind: "attach", authorization: `Bearer ${apiKey}` };
}
