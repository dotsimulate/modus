import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PageContextHandle, ScopeBinding, ScopeEvent, UiIntentObserver, UiIntentOf, UiIntentType } from "../widgets";

// ── Page-scoped shared state bus ──

type EventHandler<T extends UiIntentType = UiIntentType> = (event: UiIntentOf<T>) => void;
type StoredEventHandler = (event: ScopeEvent) => void;

export type PageStateBus = {
  state: Record<string, unknown>;
  listeners: Set<() => void>;
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  subscribe: (cb: () => void) => () => void;
  getSnapshot: () => Record<string, unknown>;
  emit: (event: ScopeEvent) => void;
  on: <T extends UiIntentType>(type: T, handler: EventHandler<T>) => () => void;
  observeIntents: (handler: UiIntentObserver) => () => void;
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
  onActivateSession?: (id: string) => void;
};

export function createPageStateBus(initial: Record<string, unknown>): PageStateBus {
  const eventHandlers = new Map<UiIntentType, Set<StoredEventHandler>>();
  const intentObservers = new Set<UiIntentObserver>();

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
      intentObservers.forEach((observer) => observer(event));
      const handlers = eventHandlers.get(event.type);
      if (handlers) handlers.forEach((h) => h(event));
    },
    on(type, handler) {
      let set = eventHandlers.get(type);
      if (!set) { set = new Set(); eventHandlers.set(type, set); }
      const stored = handler as unknown as StoredEventHandler;
      set.add(stored);
      return () => { set!.delete(stored); };
    },
    observeIntents(handler) {
      intentObservers.add(handler);
      return () => { intentObservers.delete(handler); };
    },
  };
  return bus;
}

export const PageStateBusContext = createContext<PageStateBus | null>(null);
const emptyPageState: Record<string, unknown> = {};
const subscribeToNothing = (_callback: () => void) => () => {};
const getEmptyPageState = () => emptyPageState;

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
    // Prime before publishing so the synchronous outbound subscription below
    // knows this change came from the URL and does not echo it back to App.
    lastPushed.current = next;
    if (current !== next) bus.set("sessionId", next);
  }, [bus, hashSessionId]);

  useEffect(() => {
    if (!bus) return;
    return bus.subscribe(() => {
      const sid = bus.get("sessionId") as string | null | undefined;
      if (sid === lastPushed.current) return;
      lastPushed.current = sid ?? null;
      if (sid && bus.onSelectSession) bus.onSelectSession(sid);
    });
  }, [bus]);

  return null;
}

export function ScopeSelectSessionIntentBridge() {
  const bus = useContext(PageStateBusContext);

  useEffect(() => {
    if (!bus) return;
    return bus.on("select-session", (event) => {
      bus.set("sessionId", event.sessionId);
    });
  }, [bus]);

  return null;
}

export function useLeafVisible(
  showWhen?: Record<string, unknown>,
  hideWhen?: Record<string, unknown>,
): boolean {
  const bus = useContext(PageStateBusContext);
  const tracksVisibility = !!showWhen || !!hideWhen;
  useSyncExternalStore(
    tracksVisibility && bus ? bus.subscribe : subscribeToNothing,
    tracksVisibility && bus ? bus.getSnapshot : getEmptyPageState,
  );
  if (!tracksVisibility || !bus) return true;
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

  const on = useCallback(<T extends UiIntentType>(type: T, handler: (event: UiIntentOf<T>) => void): () => void => {
    if (!bus) return () => {};
    return bus.on(type, handler);
  }, [bus]);

  const observeIntents = useCallback((handler: UiIntentObserver): (() => void) => {
    if (!bus) return () => {};
    return bus.observeIntents(handler);
  }, [bus]);

  if (!bus) return undefined;
  return {
    get,
    set,
    emit,
    on,
    observeIntents,
    navigate: canNavigate ? bus.onNavigate : undefined,
    selectSession: canNavigate ? bus.onSelectSession : undefined,
    activateSession: bus.onActivateSession,
  };
}

export function useScopeBus(): PageStateBus | null {
  return useContext(PageStateBusContext);
}

export function ScopeProvider({
  context,
  onNavigate,
  onSelectSession,
  onActivateSession,
  children,
}: {
  context?: Record<string, unknown>;
  onNavigate?: (view: string) => void;
  onSelectSession?: (id: string) => void;
  onActivateSession?: (id: string) => void;
  children: ReactNode;
}) {
  const [bus] = useState(() => createPageStateBus(context ?? {}));
  bus.onNavigate = onNavigate;
  bus.onSelectSession = onSelectSession;
  bus.onActivateSession = onActivateSession;
  return (
    <PageStateBusContext.Provider value={bus}>
      {children}
    </PageStateBusContext.Provider>
  );
}

/**
 * ScopeBindingBridge — syncs declared keys between a child scope bus and a
 * parent scope bus. Must be rendered inside the child ScopeProvider so it
 * can access the child bus via context. The parent bus is passed as a prop
 * (captured before the child ScopeProvider mounts).
 *
 * Uses the bus's built-in dedup (`if (state[key] === value) return`) to
 * prevent infinite sync loops.
 */
export function ScopeBindingBridge({
  parentBus,
  bindings,
}: {
  parentBus: PageStateBus;
  bindings: ScopeBinding[];
}) {
  const childBus = useContext(PageStateBusContext);

  useEffect(() => {
    if (!childBus || !parentBus || bindings.length === 0) return;

    const unsubs: (() => void)[] = [];

    for (const binding of bindings) {
      const { local, parent, direction } = binding;
      const syncsUp = direction === "up" || direction === "twoWay";
      const syncsDown = direction === "down" || direction === "twoWay";

      // Initial sync: parent → child for down/twoWay
      if (syncsDown) {
        const parentVal = parentBus.get(parent);
        if (parentVal !== undefined && parentVal !== null) {
          childBus.set(local, parentVal);
        }
      }
      // Initial sync: child → parent for up/twoWay (if child already has a value)
      if (syncsUp) {
        const childVal = childBus.get(local);
        if (childVal !== undefined && childVal !== null) {
          parentBus.set(parent, childVal);
        }
      }

      // Live sync: child changes → parent
      if (syncsUp) {
        unsubs.push(childBus.subscribe(() => {
          const val = childBus.get(local);
          parentBus.set(parent, val);
        }));
      }

      // Live sync: parent changes → child
      if (syncsDown) {
        unsubs.push(parentBus.subscribe(() => {
          const val = parentBus.get(parent);
          childBus.set(local, val);
        }));
      }
    }

    return () => unsubs.forEach((fn) => fn());
  }, [childBus, parentBus, bindings]);

  return null;
}
