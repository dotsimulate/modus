/**
 * Control intents, client side — the stream.
 *
 * Subscribes to `/api/events/control` and hands each intent to the routing
 * registry. The vocabulary, the wire validation, and the reasoning about why it
 * is navigation-only live in `harness/control-intents.ts`; the arithmetic and the
 * registry live in `control-intent-routing.ts`. This file is delivery, and it is
 * the single import surface for consumers.
 *
 * ## The stream only exists while something is listening
 *
 * The connection is reference-counted against the handler registry rather than
 * opened at boot. A client with no navigable surface mounted holds no stream, and
 * the server-side listener count stays an honest answer to "is anyone there" —
 * which is what lets a hardware producer show a disconnected state without a
 * separate health protocol.
 */

import { API_BASE, authHeaders } from "./modusClient";
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

const STALE_TIMEOUT_MS = 45_000;  // server pings every 30s
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

let abort: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;

function closeConnection(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectDelay = RECONNECT_MIN_MS;
  abort?.abort();
  abort = null;
}

function scheduleReconnect(): void {
  if (!controlIntentHandlerCount() || abort || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureConnection();
  }, delay);
}

function ensureConnection(): void {
  if (abort || !controlIntentHandlerCount()) return;

  const controller = new AbortController();
  abort = controller;

  let staleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStale = () => { if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; } };
  const resetStale = () => {
    clearStale();
    staleTimer = setTimeout(() => controller.abort(), STALE_TIMEOUT_MS);
  };

  const finish = () => {
    clearStale();
    if (abort === controller) { abort = null; scheduleReconnect(); }
  };

  let headers: Record<string, string>;
  try {
    headers = authHeaders();
  } catch {
    // No credential store in this runtime. Registration still works — an
    // in-process producer can call dispatchControlIntent — there is just no
    // stream to open, and retrying would spin.
    abort = null;
    return;
  }

  fetch(`${API_BASE}/api/events/control`, { signal: controller.signal, headers })
    .then(async (res) => {
      const reader = res.ok ? res.body?.getReader() : null;
      if (!reader) { finish(); return; }
      // A stream that connects is a stream that works — reset the backoff so a
      // backend restart costs one second, not the last failure's delay.
      reconnectDelay = RECONNECT_MIN_MS;
      resetStale();

      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStale();
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf("\n\n");
        while (split !== -1) {
          handleFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
          split = buffer.indexOf("\n\n");
        }
      }
      finish();
    })
    .catch(() => finish());
}

function handleFrame(frame: string): void {
  let event = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (event !== "control" || !data) return;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return; }
  // Re-validate rather than trusting the payload because it arrived
  // authenticated. The publisher already checked; this costs nothing and keeps
  // the client honest if a future producer bypasses the route.
  const intent = parseControlIntent(parsed);
  if (intent) dispatchControlIntent(intent);
}
