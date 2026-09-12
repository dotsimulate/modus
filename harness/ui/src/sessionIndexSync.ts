import type { SessionIndex, SessionInfo } from "../../sdk/index";
import { modus } from "./modusClient";

export type SessionIndexConnectionState = {
  status: "connecting" | "connected" | "reconnecting" | "offline";
  role: "leader" | "follower" | "standalone";
  lastEventAt: number | null;
  reconnects: number;
};

type IndexListener = (index: SessionIndex) => void;
type StateListener = (state: SessionIndexConnectionState) => void;
type LifecycleEvent = {
  type: string;
  sessionId: string;
  status?: string;
  costUsd?: number;
  preview?: string;
  seq?: number;
  lastText?: string | null;
  lastEventAt?: number;
  pendingCount?: number;
  lastReplySeq?: number;
  readReplySeq?: number;
};

type SyncMessage =
  | { kind: "index"; source: string; index: SessionIndex }
  | { kind: "patch"; source: string; event: LifecycleEvent; at: number }
  | { kind: "refresh-request"; source: string }
  | { kind: "heartbeat"; source: string; expiresAt: number };

const tabId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const endpoint = typeof location === "undefined" ? modus.baseUrl : (modus.baseUrl || location.origin);
const endpointKey = encodeURIComponent(endpoint || "same-origin");
const CHANNEL_NAME = `modus:session-index:${endpointKey}`;
const LEASE_KEY = `modus:session-index-leader:${endpointKey}`;
const LEASE_MS = 8_000;
const TICK_MS = 2_000;
const FALLBACK_POLL_MS = 60_000;

let currentIndex: SessionIndex | null = null;
let state: SessionIndexConnectionState = {
  status: "offline",
  role: "standalone",
  lastEventAt: null,
  reconnects: 0,
};
let channel: BroadcastChannel | null = null;
let tickTimer: ReturnType<typeof setInterval> | null = null;
let currentStream: { abort: () => void } | null = null;
let streamGeneration = 0;
let started = false;
let leader = false;
let lastFetchAt = 0;
let fetchPromise: Promise<SessionIndex> | null = null;
let fetchGeneration = 0;
const indexListeners = new Set<IndexListener>();
const stateListeners = new Set<StateListener>();
const refreshWaiters = new Set<(index: SessionIndex) => void>();

function updateState(patch: Partial<SessionIndexConnectionState>) {
  state = { ...state, ...patch };
  for (const listener of stateListeners) listener(state);
}

function notifyIndex(index: SessionIndex) {
  // A snapshot requested before a completion/read event must not undo it.
  const previous = new Map(currentIndex?.sessions.map((session) => [session.id, session]));
  index = { ...index, sessions: index.sessions.map((session) => {
    const prior = previous.get(session.id);
    const lastReply = Math.max(session.last_reply_seq ?? 0, prior?.last_reply_seq ?? 0);
    const readReply = Math.max(session.read_reply_seq ?? 0, prior?.read_reply_seq ?? 0);
    if (lastReply === (session.last_reply_seq ?? 0) && readReply === (session.read_reply_seq ?? 0)) return session;
    return { ...session, last_reply_seq: lastReply, read_reply_seq: readReply };
  }) };
  currentIndex = index;
  for (const listener of indexListeners) listener(index);
  for (const resolve of refreshWaiters) resolve(index);
  refreshWaiters.clear();
  return index;
}

function post(message: SyncMessage) {
  try { channel?.postMessage(message); } catch { /* channel unavailable */ }
}

async function fetchIndex(broadcast = true, force = false): Promise<SessionIndex> {
  if (fetchPromise && !force) return fetchPromise;
  const generation = ++fetchGeneration;
  const run = modus.getSessionIndex(250).then((index) => {
    // A foreground resume may supersede a fetch that was frozen mid-request.
    // Redirect its callers to the newer request/snapshot too: refreshSessions
    // applies the returned value, so merely suppressing notifyIndex here would
    // still let a late stale response replace the visible index.
    if (generation !== fetchGeneration) {
      return fetchPromise ?? currentIndex ?? index;
    }
    lastFetchAt = Date.now();
    index = notifyIndex(index);
    if (broadcast) post({ kind: "index", source: tabId, index });
    return index;
  }).finally(() => {
    if (fetchPromise === run) fetchPromise = null;
  });
  fetchPromise = run;
  return run;
}

function patchSession(session: SessionInfo, event: LifecycleEvent, at: number): SessionInfo {
  if (event.type === "session:read-state") {
    return {
      ...session,
      last_reply_seq: Math.max(session.last_reply_seq ?? 0, event.lastReplySeq ?? 0),
      read_reply_seq: Math.max(session.read_reply_seq ?? 0, event.readReplySeq ?? 0),
    };
  }
  if (event.type === "session:activity") {
    return {
      ...session,
      status: event.status ?? session.status,
      total_cost_usd: event.costUsd ?? session.total_cost_usd,
      live_text: event.lastText ?? session.live_text,
      live_seq: event.seq ?? session.live_seq,
      last_event_at: event.lastEventAt ?? at,
      updated_at: Math.max(session.updated_at, event.lastEventAt ?? at),
    };
  }
  if (event.type === "session:status") {
    return {
      ...session,
      status: event.status ?? session.status,
      total_cost_usd: event.costUsd ?? session.total_cost_usd,
      preview: event.preview ?? session.preview,
      updated_at: Math.max(session.updated_at, at),
      last_event_at: at,
    };
  }
  if (event.type === "session:permission") {
    return { ...session, pending_permission_count: event.pendingCount ?? 0 };
  }
  return session;
}

function applyPatch(event: LifecycleEvent, at: number, broadcast: boolean): boolean {
  if (!currentIndex) return false;
  const index = currentIndex.sessions.findIndex((session) => session.id === event.sessionId);
  if (index < 0) return false;
  const sessions = [...currentIndex.sessions];
  sessions[index] = patchSession(sessions[index]!, event, at);
  const next = { ...currentIndex, generated_at: at, sessions };
  notifyIndex(next);
  if (broadcast) post({ kind: "patch", source: tabId, event, at });
  return true;
}

export async function handleSessionIndexLifecycleEvent(event: LifecycleEvent) {
  const at = Date.now();
  updateState({ status: "connected", lastEventAt: at });
  if (event.type === "session:activity" || event.type === "session:status" || event.type === "session:permission" || event.type === "session:read-state") {
    if (applyPatch(event, at, true)) return;
    // Internal sessions and rows beyond the index limit also stream events.
    // They stay absent after a refresh; fetching again on every token creates
    // a request loop. Membership events still refresh immediately below.
    if (at - lastFetchAt < FALLBACK_POLL_MS) return;
  }
  // Creation, archive, rekey, and an unknown status target change membership
  // or identity, so refresh the authoritative compact index once.
  await fetchIndex(true).catch(() => {});
}

function delay(ms: number, generation: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (generation !== streamGeneration) {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function runLifecycleStream(generation: number) {
  let failures = 0;
  while (started && leader && generation === streamGeneration) {
    updateState({ status: failures === 0 ? "connecting" : "reconnecting" });
    const handle = modus.subscribeGlobalEvents();
    currentStream = handle;
    try {
      for await (const envelope of handle.events) {
        if (!started || !leader || generation !== streamGeneration) break;
        failures = 0;
        await handleSessionIndexLifecycleEvent((envelope as any).data as LifecycleEvent);
      }
      if (started && leader && generation === streamGeneration) throw new Error("session lifecycle stream closed");
    } catch {
      if (!started || !leader || generation !== streamGeneration) break;
      failures++;
      updateState({
        status: "reconnecting",
        reconnects: state.reconnects + 1,
      });
      await delay(Math.min(5_000, 400 * (2 ** Math.min(failures, 4))), generation);
    } finally {
      if (currentStream === handle) currentStream = null;
      handle.abort();
    }
  }
}

function readLease(): { id: string; expiresAt: number } | null {
  try {
    const raw = localStorage.getItem(LEASE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed?.id === "string" && typeof parsed?.expiresAt === "number" ? parsed : null;
  } catch { return null; }
}

function writeLease(expiresAt: number): boolean {
  try {
    localStorage.setItem(LEASE_KEY, JSON.stringify({ id: tabId, expiresAt }));
    return readLease()?.id === tabId;
  } catch { return false; }
}

function loseLeadership() {
  if (!leader) return;
  leader = false;
  streamGeneration++;
  currentStream?.abort();
  currentStream = null;
  updateState({ status: "connecting", role: channel ? "follower" : "standalone" });
}

function becomeLeader(role: SessionIndexConnectionState["role"] = "leader") {
  if (leader) return;
  leader = true;
  streamGeneration++;
  updateState({ status: "connecting", role });
  void fetchIndex(true).catch(() => updateState({ status: "offline" }));
  void runLifecycleStream(streamGeneration);
}

function restartLifecycleStream() {
  if (!started || !leader) return;
  streamGeneration++;
  currentStream?.abort();
  currentStream = null;
  updateState({ status: "connecting" });
  void runLifecycleStream(streamGeneration);
}

function maintainLease() {
  if (!started) return;
  if (!channel) {
    becomeLeader("standalone");
    return;
  }

  const now = Date.now();
  const lease = readLease();
  if (leader) {
    if (lease && lease.id !== tabId && lease.expiresAt > now) {
      loseLeadership();
      return;
    }
    const expiresAt = now + LEASE_MS;
    if (!writeLease(expiresAt)) {
      loseLeadership();
      return;
    }
    post({ kind: "heartbeat", source: tabId, expiresAt });
    if (now - lastFetchAt >= FALLBACK_POLL_MS) void fetchIndex(true).catch(() => {});
    return;
  }

  if (!lease || lease.expiresAt <= now) {
    if (writeLease(now + LEASE_MS)) becomeLeader("leader");
  }
}

function onChannelMessage(event: MessageEvent<SyncMessage>) {
  const message = event.data;
  if (!message || message.source === tabId) return;
  if (message.kind === "index") {
    notifyIndex(message.index);
    updateState({ status: "connected", role: leader ? "leader" : "follower", lastEventAt: Date.now() });
  } else if (message.kind === "patch") {
    applyPatch(message.event, message.at, false);
    updateState({ status: "connected", role: leader ? "leader" : "follower", lastEventAt: message.at });
  } else if (message.kind === "refresh-request" && leader) {
    void fetchIndex(true).catch(() => {});
  }
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.addEventListener("message", onChannelMessage);
    } catch { channel = null; }
  }
  window.addEventListener("storage", maintainLease);
  window.addEventListener("beforeunload", releaseLease);
  tickTimer = setInterval(maintainLease, TICK_MS);
  maintainLease();
  if (!leader) post({ kind: "refresh-request", source: tabId });
}

function releaseLease() {
  try {
    if (readLease()?.id === tabId) localStorage.removeItem(LEASE_KEY);
  } catch { /* ignored */ }
}

function stop() {
  if (!started) return;
  started = false;
  releaseLease();
  loseLeadership();
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  channel?.removeEventListener("message", onChannelMessage);
  channel?.close();
  channel = null;
  window.removeEventListener("storage", maintainLease);
  window.removeEventListener("beforeunload", releaseLease);
  updateState({ status: "offline", role: "standalone" });
}

export function subscribeSessionIndex(
  onIndex: IndexListener,
  onState?: StateListener,
): () => void {
  indexListeners.add(onIndex);
  if (onState) stateListeners.add(onState);
  if (currentIndex) onIndex(currentIndex);
  if (onState) onState(state);
  start();
  return () => {
    indexListeners.delete(onIndex);
    if (onState) stateListeners.delete(onState);
    if (indexListeners.size === 0 && stateListeners.size === 0) stop();
  };
}

export function refreshSessionIndex(): Promise<SessionIndex> {
  if (!started || leader || !channel) return fetchIndex(true);
  post({ kind: "refresh-request", source: tabId });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (index: SessionIndex) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      refreshWaiters.delete(finish);
      resolve(index);
    };
    const timer = setTimeout(() => {
      refreshWaiters.delete(finish);
      void fetchIndex(false).then(finish);
    }, 1_500);
    refreshWaiters.add(finish);
  });
}

/**
 * Reconcile immediately after a browser returns from suspension.
 *
 * A frozen tab may retain both an expired leader lease and a fetch whose TCP
 * connection died while JavaScript timers were paused. Re-elect synchronously,
 * force a new compact snapshot, and replace the lifecycle stream when this tab
 * still owns it. Followers fetch their own snapshot too so a frozen leader
 * cannot keep the visible tab stale.
 */
export function resumeSessionIndex(): void {
  if (!started) return;
  const wasLeader = leader;
  const previousFetch = fetchPromise;
  maintainLease();

  if (leader) {
    const leaseStartedFetch = fetchPromise !== previousFetch;
    void fetchIndex(true, !leaseStartedFetch).catch(() => updateState({ status: "offline" }));
    if (wasLeader) restartLifecycleStream();
    return;
  }

  post({ kind: "refresh-request", source: tabId });
  void fetchIndex(false, true).catch(() => updateState({ status: "offline" }));
}

export function getSessionIndexSnapshot(): SessionIndex | null {
  return currentIndex;
}

export function applySessionReadReceipt(sessionId: string, receipt: { last_reply_seq: number; read_reply_seq: number }): void {
  applyPatch({
    type: "session:read-state", sessionId,
    lastReplySeq: receipt.last_reply_seq, readReplySeq: receipt.read_reply_seq,
  }, Date.now(), true);
}
