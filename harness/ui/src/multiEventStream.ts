/**
 * Multiplexed session event stream.
 *
 * One SSE connection (`/api/events/multi`) carries catch-up + live events for
 * EVERY subscribed session, each event tagged with its session id. This
 * replaces the old one-fetch-per-session model so the browser's ~6 concurrent
 * HTTP/1.1 connection cap can't be exhausted when many agents run at once.
 *
 * The connection is reopened — each session resuming from its own cursor —
 * whenever the set of subscribed sessions changes.
 *
 * Fallback: if the backend doesn't expose `/api/events/multi` yet (e.g. it
 * hasn't been restarted with the new code), the manager transparently falls
 * back to per-session streams (the previous behavior) so the UI never breaks
 * mid-deploy. Once the multiplexed endpoint is reachable, it is used.
 */

import { API_BASE, authHeaders, subscribeEvents, type EventStreamCallbacks } from "./modusClient";

export type MultiCallbacks = {
  onEvent: (event: any, seq: number) => void;
  onEventBatch?: (events: { event: string; data: any; seq: number }[]) => void;
  onDone: () => void;
  onDisconnect?: () => void;
  onError?: (error: string) => void;
};

type Reg = {
  /** Highest seq seen — used as the resume cursor on reconnect. */
  cursor: number;
  callbacks: MultiCallbacks;
  /** Per-session catch-up accumulator while replaying history. */
  buffer: { event: string; data: any; seq: number }[] | null;
  /** Per-session stream teardown (fallback mode only). */
  fbUnsub?: () => void;
  fbRetry?: ReturnType<typeof setTimeout> | null;
};

const registry = new Map<string, Reg>();

// ── Multiplexed-connection state ──
let abort: AbortController | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 0;

// Once we learn the multiplexed endpoint is missing, route through per-session
// streams for the rest of the session (until reload). Re-probed only on reload.
let fallbackMode = false;
// True once the multiplexed stream has connected at least once. Distinguishes a
// transient drop (keep retrying the multiplexed stream) from an endpoint that
// never works (degrade to per-session streams).
let everConnected = false;

const STALE_TIMEOUT_MS = 45_000; // server pings every 30s
const CONNECT_DEBOUNCE_MS = 40;

// ── Public API ──

export function multiSubscribe(sessionId: string, afterSeq: number, callbacks: MultiCallbacks): () => void {
  const existing = registry.get(sessionId);
  const reg: Reg = {
    cursor: existing ? Math.max(existing.cursor, afterSeq) : afterSeq,
    callbacks,
    buffer: null,
    fbUnsub: existing?.fbUnsub,
    fbRetry: existing?.fbRetry ?? null,
  };
  registry.set(sessionId, reg);

  if (fallbackMode) {
    openFallback(sessionId, reg);
  } else {
    scheduleConnect();
  }

  // Find by reg identity, not by id — the registration may have been rekeyed
  // (temp ses-* → real UUID) to a different key since it was created.
  return () => {
    for (const [id, r] of registry) {
      if (r === reg) {
        teardownFallback(r);
        registry.delete(id);
        if (!fallbackMode) scheduleConnect();
        return;
      }
    }
  };
}

export function isMultiSubscribed(sessionId: string): boolean {
  return registry.has(sessionId);
}

/**
 * Force a reconnect so the backend re-evaluates live subscriptions — e.g. a
 * settled session just reactivated (user sent a message) and now needs a live
 * subscription attached to the shared stream.
 */
export function multiReconnect(): void {
  if (fallbackMode) return; // per-session streams self-manage
  scheduleConnect();
}

/** Move a registration to a new id (e.g. temp ses-* → real UUID). */
export function multiRekey(oldId: string, newId: string): void {
  const reg = registry.get(oldId);
  if (!reg) return;
  teardownFallback(reg);
  registry.delete(oldId);
  // Reuse the same reg object so the unsubscribe closure (which matches by reg
  // identity) still resolves after the rekey. Keep the cursor — stale ids
  // resolve through the store's rekeyMap, so the seq sequence is continuous.
  reg.buffer = null;
  registry.set(newId, reg);
  if (fallbackMode) openFallback(newId, reg);
  else scheduleConnect();
}

export function multiUnsubscribeAll(): void {
  for (const reg of registry.values()) teardownFallback(reg);
  registry.clear();
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  clearStale();
  abort?.abort();
  abort = null;
}

// ── Multiplexed connection ──

function scheduleConnect() {
  if (connectTimer) return;
  connectTimer = setTimeout(() => { connectTimer = null; connect(); }, CONNECT_DEBOUNCE_MS);
}

function clearStale() { if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; } }
function resetStale() {
  clearStale();
  staleTimer = setTimeout(() => { abort?.abort(); }, STALE_TIMEOUT_MS);
}

function connect() {
  abort?.abort();
  clearStale();
  if (fallbackMode) return;
  if (registry.size === 0) { abort = null; return; }

  const specs = [...registry.entries()].map(([id, r]) => ({ i: id, s: r.cursor }));
  const url = `${API_BASE}/api/events/multi`;

  const ac = new AbortController();
  abort = ac;

  fetch(url, {
    method: "POST",
    signal: ac.signal,
    headers: authHeaders(),
    body: JSON.stringify({ sessions: specs }),
  })
    .then(async (res) => {
      if (res.status === 404 || res.status === 405) { enableFallback(); return; }
      if (!res.ok) throw new Error(`multi events ${res.status}`);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let buf = "";
      let event = ""; // persists across chunks — a message may split mid-frame
      resetStale();
      backoff = 0;
      everConnected = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStale();
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) { route(event, line.slice(6)); event = ""; }
        }
      }
      throw new Error("multi stream closed");
    })
    .catch(() => {
      clearStale();
      if (ac.signal.aborted) return; // intentional teardown (set change / unsub-all)
      if (fallbackMode) return;      // switched to per-session mid-flight
      backoff = Math.min(backoff + 1, 5);
      // If the endpoint never connected (likely broken or unreachable), degrade
      // to per-session streams so live updates still work. A drop AFTER a
      // successful connect is treated as transient — keep retrying the
      // multiplexed stream so it recovers on its own.
      if (!everConnected && backoff >= 3) { enableFallback(); return; }
      const delay = 500 * backoff;
      if (connectTimer) return;
      connectTimer = setTimeout(() => { connectTimer = null; connect(); }, delay);
    });
}

function route(event: string, dataStr: string) {
  if (!event || event === "ping") return;
  let data: any;
  try { data = JSON.parse(dataStr); } catch { return; }
  const sid: string | undefined = data?.sid;
  if (!sid) return;
  const reg = registry.get(sid);
  if (!reg) return;

  switch (event) {
    case "catchup-start":
      reg.buffer = [];
      break;
    case "catchup-end": {
      const batch = reg.buffer;
      reg.buffer = null;
      if (batch && batch.length) {
        reg.cursor = Math.max(reg.cursor, batch[batch.length - 1].seq);
        if (reg.callbacks.onEventBatch) reg.callbacks.onEventBatch(batch);
        else for (const e of batch) reg.callbacks.onEvent(e.data, e.seq);
      }
      break;
    }
    case "done":
      reg.callbacks.onDone();
      break;
    case "ev": {
      const seq = Number(data.seq) || 0;
      const ev = data.ev;
      if (reg.buffer) {
        reg.buffer.push({ event: ev?.type ?? "", data: ev, seq });
      } else {
        if (seq > reg.cursor) reg.cursor = seq;
        reg.callbacks.onEvent(ev, seq);
      }
      break;
    }
  }
}

// ── Per-session fallback (used when /api/events/multi is unavailable) ──

function enableFallback() {
  if (fallbackMode) return;
  fallbackMode = true;
  abort?.abort();
  abort = null;
  clearStale();
  if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
  for (const [id, reg] of registry) openFallback(id, reg);
}

function openFallback(sessionId: string, reg: Reg) {
  teardownFallback(reg);
  reg.fbUnsub = subscribeEvents(sessionId, reg.cursor, fallbackCallbacks(sessionId, reg));
}

function fallbackCallbacks(sessionId: string, reg: Reg): EventStreamCallbacks {
  return {
    onEvent: (event, seq) => {
      if (seq > reg.cursor) reg.cursor = seq;
      reg.callbacks.onEvent(event, seq);
    },
    onEventBatch: (events) => {
      if (events.length) {
        const m = events[events.length - 1].seq;
        if (m > reg.cursor) reg.cursor = m;
      }
      if (reg.callbacks.onEventBatch) reg.callbacks.onEventBatch(events);
      else for (const e of events) reg.callbacks.onEvent(e.data, e.seq);
    },
    onDone: () => reg.callbacks.onDone(),
    onDisconnect: () => {
      if (!registry.has(sessionId)) return;
      reg.fbRetry = setTimeout(() => {
        if (registry.get(sessionId) === reg) openFallback(sessionId, reg);
      }, 2000);
    },
    onError: (err) => reg.callbacks.onError?.(err),
  };
}

function teardownFallback(reg: Reg) {
  if (reg.fbRetry) { clearTimeout(reg.fbRetry); reg.fbRetry = null; }
  if (reg.fbUnsub) { reg.fbUnsub(); reg.fbUnsub = undefined; }
}
