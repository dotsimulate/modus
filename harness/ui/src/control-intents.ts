/**
 * Control intents, client side — the stream.
 *
 * Listens on the `control` channel of the browser event hub (`eventHub.ts`) and
 * hands each intent to the routing registry. The vocabulary, the wire
 * validation, and the reasoning about why it is navigation-only live in
 * `harness/control-intents.ts`; the arithmetic and the registry live in
 * `control-intent-routing.ts`. This file is delivery, and it is the single
 * import surface for consumers.
 *
 * ## The subscription only exists while something is listening
 *
 * The hub channel is reference-counted against the handler registry rather than
 * opened at boot. A client with no navigable surface mounted does not subscribe
 * to `control`, and the server-side listener count stays an honest answer to "is anyone there" —
 * which is what lets a hardware producer show a disconnected state without a
 * separate health protocol.
 */

import { onHubEvent } from "./eventHub";
import { parseControlIntent, type ControlIntent, type ControlIntentName } from "../../control-intents";
import {
  controlIntentHandlerCount,
  dispatchControlIntent,
  registerControlIntentHandler,
  resetControlIntentHandlers,
  type ControlIntentHandler,
  type ControlIntentHandlerOptions,
} from "./control-intent-routing";

export {
  currentTurnKey,
  dispatchControlIntent,
  scrollIntentPixels,
  stepSessionId,
  stepTurnKey,
} from "./control-intent-routing";
export type { ControlIntent, ControlIntentName, ControlIntentHandler, ControlIntentHandlerOptions };

export function onControlIntent(
  name: ControlIntentName,
  handler: ControlIntentHandler,
  options?: ControlIntentHandlerOptions,
): () => void {
  const unregister = registerControlIntentHandler(name, handler, options);
  ensureConnection();

  return () => {
    unregister();
    if (!controlIntentHandlerCount()) closeConnection();
  };
}

/** Test seam — drops every handler and the stream without unmounting anything. */
export function resetControlIntents(): void {
  resetControlIntentHandlers();
  closeConnection();
}

// ── Stream ──

let unsubscribeHub: (() => void) | null = null;

function closeConnection(): void {
  unsubscribeHub?.();
  unsubscribeHub = null;
}

function ensureConnection(): void {
  if (unsubscribeHub || !controlIntentHandlerCount()) return;
  unsubscribeHub = onHubEvent("control", handleIntent);
}

function handleIntent(payload: unknown): void {
  // Re-validate rather than trusting the payload because it arrived
  // authenticated. The publisher already checked; this costs nothing and keeps
  // the client honest if a future producer bypasses the route.
  const intent = parseControlIntent(payload);
  if (intent) dispatchControlIntent(intent);
}
