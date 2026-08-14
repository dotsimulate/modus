/**
 * Session event persistence policy.
 *
 * A provider reaches session-manager through two emit methods, and it is easy to
 * read them as "one writes to the database, one does not". That is not the rule.
 * Two event types override whichever method was called:
 *
 *   - `stream_event` is never durable. It is the token-level stream, it is
 *     coalesced before it reaches a subscriber, and the assistant turn it belongs
 *     to is materialized separately. Persisting it would store the same turn twice.
 *   - `error` is always durable. A terminal error has to outlive whichever socket
 *     happened to be open, and a pre-flight failure is broadcast before any
 *     assistant turn exists, so nothing else would record it. Every provider
 *     reaches for the broadcast method for this, so the promotion lives here
 *     rather than in each of those call sites.
 *
 * Everything else honors the caller's request. Keeping the rule in one pure
 * function is what stops the two emit paths from drifting apart again.
 */

export type EventPersistence = "durable" | "live-only";

/** Event types that are never written to the durable event log. */
export const LIVE_ONLY_EVENT_TYPES = ["stream_event"] as const;

/** Event types that are always written to the durable event log. */
export const ALWAYS_DURABLE_EVENT_TYPES = ["error"] as const;

/**
 * Resolve how an event must be handled, given what the caller asked for.
 *
 * `requested` is `"durable"` for the persist-and-broadcast entry point and
 * `"live-only"` for the broadcast-only one.
 */
export function resolveEventPersistence(event: unknown, requested: EventPersistence): EventPersistence {
  const type = eventType(event);
  if (type && (LIVE_ONLY_EVENT_TYPES as readonly string[]).includes(type)) return "live-only";
  if (type && (ALWAYS_DURABLE_EVENT_TYPES as readonly string[]).includes(type)) return "durable";
  return requested;
}

/** True when an event is written to the durable event log regardless of the emit method used. */
export function isAlwaysDurableEvent(event: unknown): boolean {
  return resolveEventPersistence(event, "live-only") === "durable";
}

/** True when an event is broadcast only, regardless of the emit method used. */
export function isLiveOnlyEvent(event: unknown): boolean {
  return resolveEventPersistence(event, "durable") === "live-only";
}

function eventType(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}
