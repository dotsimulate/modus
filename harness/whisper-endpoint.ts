/**
 * Whisper endpoint resolution.
 *
 * The harness — not the browser — performs the transcription fetch, so the
 * endpoint is backend configuration. It must be identical for every client, and
 * that is exactly what it was not: the endpoint arrived as a multipart field
 * from whichever client happened to be recording. Client-extension settings
 * resolve per user profile, and a phone seeds its own profile, so a client that
 * had never opened the settings form sent no field at all. The route then fell
 * back to its loopback default, the backend dialled *itself*, nothing was
 * listening, and the failure surfaced as a bare `whisper 502` that read like a
 * network fault for days.
 *
 * Two rules follow, and both are encoded here rather than in the route:
 *
 *  - The endpoint is resolved from configuration the backend owns, never from
 *    the request body.
 *  - Failing to reach the *default* is a configuration error, not a
 *    transcription failure. They are reported differently.
 */

/** Where a resolved endpoint came from, for diagnostics and error text. */
export type WhisperEndpointSource = "setting" | "legacy-profile-setting" | "env" | "default";

export type WhisperEndpointResolution =
  | { kind: "ok"; url: string; source: WhisperEndpointSource; configured: boolean }
  | { kind: "invalid"; error: string; source: WhisperEndpointSource };

/** Endpoint used when nothing at all is configured. Only meaningful for a
 *  whisper server running on the same machine as the harness. */
export const DEFAULT_WHISPER_URL = "http://127.0.0.1:8080/v1/audio/transcriptions";

function firstConfigured(
  candidates: Array<{ value: string | undefined; source: WhisperEndpointSource }>,
): { value: string; source: WhisperEndpointSource } | undefined {
  for (const candidate of candidates) {
    const trimmed = candidate.value?.trim();
    if (trimmed) return { value: trimmed, source: candidate.source };
  }
  return undefined;
}

/**
 * Resolve the upstream transcription endpoint.
 *
 * Order follows the harness config chain — the most specific explicit value
 * wins, environment is a fallback, and the hardcoded loopback address is last.
 * `sharedSetting` is the backend-scoped value shared by every client;
 * `profileSetting` is the same setting read from a single user profile, kept
 * only so installs that configured it before the setting became backend-scoped
 * keep working.
 */
export function resolveWhisperEndpoint(input: {
  sharedSetting?: string;
  profileSetting?: string;
  env?: string;
}): WhisperEndpointResolution {
  const picked = firstConfigured([
    { value: input.sharedSetting, source: "setting" },
    { value: input.profileSetting, source: "legacy-profile-setting" },
    { value: input.env, source: "env" },
  ]);

  const source: WhisperEndpointSource = picked?.source ?? "default";
  const raw = picked?.value ?? DEFAULT_WHISPER_URL;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: "invalid", error: `invalid whisper url: ${raw}`, source };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      kind: "invalid",
      error: `whisper url must be http or https, got ${parsed.protocol.replace(/:$/, "")}`,
      source,
    };
  }

  return { kind: "ok", url: parsed.toString(), source, configured: picked !== undefined };
}

/**
 * Build the client-facing message for a failed upstream fetch.
 *
 * An unreachable *configured* endpoint is an operational problem — the server is
 * down, the host is wrong. An unreachable *default* means nothing was ever
 * configured for this profile, which the user can act on only if the message
 * says so. Collapsing both into "whisper transcription failed" is what made a
 * missing setting look like a Tailscale fault.
 */
export function describeWhisperFetchFailure(
  resolution: Extract<WhisperEndpointResolution, { kind: "ok" }>,
  detail?: string,
): string {
  if (!resolution.configured) {
    return `no whisper endpoint is configured, so the default ${resolution.url} was tried `
      + `and nothing is listening there. Set the Whisper API URL in the transcription `
      + `extension settings — it is shared by every client, so setting it once is enough.`;
  }
  const suffix = detail?.trim() ? `: ${detail.trim()}` : "";
  return `could not reach the whisper endpoint ${resolution.url}${suffix}`;
}
