import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PageContextHandle, ScopeEvent } from "../widgets";

// ── Page-scoped shared state bus ──

const emptyBusSnapshot: Record<string, unknown> = {};

type EventHandler = (event: ScopeEvent) => void;

export type PageStateBus = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => Record<string, unknown>;
  emit: (event: ScopeEvent) => void;
  on: (type: string, handler: EventHandler) => () => void;
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
};

export function createPageStateBus(initial: Record<string, unknown>): PageStateBus {
  const eventHandlers = new Map<string, Set<EventHandler>>();

  const bus: PageStateBus = {
    state: { ...initial },
    listeners: new Set(),
    get(key) { return bus.state[key]; },
    set(key, value) {
      if (bus.state[key] === value) return;
      bus.state = { ...bus.state, [key]: value };
      bus.listeners.forEach((cb) => cb());
    },
    subscribe(cb) {
      bus.listeners.add(cb);
      return () => { bus.listeners.delete(cb); };
    },
    getSnapshot() { return bus.state; },
    emit(event) {
      const handlers = eventHandlers.get(event.type);
      if (handlers) handlers.forEach((h) => h(event));
    },
    on(type, handler) {
      let set = eventHandlers.get(type);
      if (!set) { set = new Set(); eventHandlers.set(type, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    },
  };
  return bus;
}

export const PageStateBusContext = createContext<PageStateBus | null>(null);

// ── Page URL context ──

type PageUrlState = {
  hashSessionId: string | null;
};

const PageUrlContext = createContext<PageUrlState>({ hashSessionId: null });

export function PageUrlProvider({
  hashSessionId,
  children,
}: {
  hashSessionId: string | null;
  children: ReactNode;
}) {
  return (
    <PageUrlContext.Provider value={{ hashSessionId }}>
      {children}
    </PageUrlContext.Provider>
  );
}

export function usePageUrl(): PageUrlState {
  return useContext(PageUrlContext);
}

export function ScopeUrlSessionBinder() {
  const bus = useContext(PageStateBusContext);
  const { hashSessionId } = usePageUrl();
  const lastPushed = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!bus) return;
    const current = bus.get("sessionId") as string | null | undefined;
    const next = hashSessionId ?? null;
    if (current !== next) bus.set("sessionId", next);
    lastPushed.current = next;
  }, [bus, hashSessionId]);

  const busState = useSyncExternalStore<Record<string, unknown>>(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => emptyBusSnapshot,
  );
  useEffect(() => {
    if (!bus) return;
    const sid = busState.sessionId as string | null | undefined;
    if (sid === lastPushed.current) return;
    lastPushed.current = sid ?? null;
    if (sid && bus.onSelectSession) bus.onSelectSession(sid);
  }, [bus, busState.sessionId]);

  return null;
}

export function useLeafVisible(
  showWhen?: Record<string, unknown>,
  hideWhen?: Record<string, unknown>,
): boolean {
  const bus = useContext(PageStateBusContext);
  useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => ({}),
  );
  if (!bus) return true;
  if (showWhen) {
    for (const [key, expected] of Object.entries(showWhen)) {
      const actual = bus.get(key);
      if (expected === null) {
        if (actual != null) return false;
      } else if (actual !== expected) {
        return false;
      }
    }
  }
  if (hideWhen) {
    for (const [key, expected] of Object.entries(hideWhen)) {
      const actual = bus.get(key);
      if (expected === null) {
        if (actual == null) return false;
      } else if (actual === expected) {
        return false;
      }
    }
  }
  return true;
}

export function usePageContext(
  publishKeys?: Record<string, string>,
  subscribeKeys?: Record<string, string>,
  canNavigate?: boolean,
): PageContextHandle | undefined {
  const bus = useContext(PageStateBusContext);
  useSyncExternalStore(
    bus ? bus.subscribe : () => () => {},
    bus ? bus.getSnapshot : () => ({}),
  );

  const publishRef = useRef(publishKeys);
  publishRef.current = publishKeys;
  const subscribeRef = useRef(subscribeKeys);
  subscribeRef.current = subscribeKeys;

  const get = useCallback((key: string): unknown => {
    if (!bus) return undefined;
    const contextKey = subscribeRef.current?.[key] ?? key;
    return bus.get(contextKey);
  }, [bus]);

  const set = useCallback((key: string, value: unknown): void => {
    if (!bus) return;
    const contextKey = publishRef.current?.[key] ?? key;
    bus.set(contextKey, value);
  }, [bus]);

  const emit = useCallback((event: ScopeEvent): void => {
    bus?.emit(event);
  }, [bus]);

  const on = useCallback((type: string, handler: (event: ScopeEvent) => void): () => void => {
    if (!bus) return () => {};
    return bus.on(type, handler);
  }, [bus]);

  if (!bus) return undefined;
  return {
    get,
    set,
    emit,
    on,
    navigate: canNavigate ? bus.onNavigate : undefined,
    selectSession: canNavigate ? bus.onSelectSession : undefined,
  };
}

export function useScopeBus(): PageStateBus | null {
  return useContext(PageStateBusContext);
}

export function ScopeProvider({
  context,
  onNavigate,
  onSelectSession,
  children,
}: {
  context?: Record<string, unknown>;
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
  children: ReactNode;
}) {
  const [bus] = useState(() => createPageStateBus(context ?? {}));
  bus.onNavigate = onNavigate;
  bus.onSelectSession = onSelectSession;
  return (
    <PageStateBusContext.Provider value={bus}>
      {children}
    </PageStateBusContext.Provider>
  );
}
