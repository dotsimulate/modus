/**
 * One reading of a terminal `error` event, shared by every pipeline.
 *
 * Two shapes reach the transcript and they disagree on the key: providers
 * broadcast `{ type: "error", error }` while the session manager's own delivery
 * failures use `{ type: "error", message }`. The live reducer read only `error`,
 * so a delivery failure rendered as the generic fallback and said nothing.
 *
 * Dependency-free on purpose — the backend, the browser bundle and the history
 * reconstruction all import it, which is what stops the live and reload paths
 * from drifting apart again.
 */

/** Shown when an error event carries no usable text of its own. */
export const PROVIDER_ERROR_FALLBACK = "The provider failed before this turn could start.";

/** Text for a terminal error event, or "" when the event carries none. */
export function providerErrorText(event: any): string {
  const candidates = [event?.error, event?.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

/** Text for display, falling back rather than rendering an empty notice. */
export function providerErrorDisplayText(event: any): string {
  return providerErrorText(event) || PROVIDER_ERROR_FALLBACK;
}
