import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { useSession } from "./SessionProvider";
import { saveSessionUiState } from "../api";

const STORAGE_KEY = "mo:pinboards";

export type PinGroup = {
  id: string;
  name: string;
  paths: string[];
};

type PinboardState = {
  groups: PinGroup[];
  activeGroupId: string | null;
};

type PinboardContextValue = {
  groups: PinGroup[];
  activeGroupId: string | null;
  activeGroup: PinGroup | null;
  setActiveGroup: (id: string) => void;
  addGroup: (name: string) => string;
  removeGroup: (id: string) => void;
  renameGroup: (id: string, name: string) => void;
  pinToActive: (path: string) => void;
  pinToGroup: (groupId: string, path: string) => void;
  unpinFromActive: (path: string) => void;
  isFilePinned: (path: string) => boolean;
};

const PinboardContext = createContext<PinboardContextValue>({
  groups: [],
  activeGroupId: null,
  activeGroup: null,
  setActiveGroup: () => {},
  addGroup: () => "",
  removeGroup: () => {},
  renameGroup: () => {},
  pinToActive: () => {},
  pinToGroup: () => {},
  unpinFromActive: () => {},
  isFilePinned: () => false,
});

export function usePinboard() {
  return useContext(PinboardContext);
}

function load(): PinboardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<PinboardState>;
    const groups = Array.isArray(parsed.groups) ? parsed.groups.filter(
      (g) => g && typeof g.id === "string" && typeof g.name === "string" && Array.isArray(g.paths)
    ) : [];
    if (groups.length === 0) return defaultState();
    const activeGroupId = typeof parsed.activeGroupId === "string"
      ? (groups.find(g => g.id === parsed.activeGroupId) ? parsed.activeGroupId : groups[0].id)
      : groups[0].id;
    return { groups, activeGroupId };
  } catch {
    return defaultState();
  }
}

function defaultState(): PinboardState {
  const id = crypto.randomUUID();
  return { groups: [{ id, name: "main", paths: [] }], activeGroupId: id };
}

function save(state: PinboardState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function PinboardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PinboardState>(() => load());
  const { activeSession } = useSession();

  const update = useCallback((updater: (s: PinboardState) => PinboardState) => {
    setState((prev) => {
      const next = updater(prev);
      save(next);
      return next;
    });
  }, []);

  // Sync active group paths to session UI state so server-side moves can read live pinboard state
  const activeGroup = state.groups.find((g) => g.id === state.activeGroupId) ?? null;
  useEffect(() => {
    const sessionId = activeSession?.id;
    if (!sessionId || sessionId.startsWith("pending-")) return;
    saveSessionUiState(sessionId, { pinnedFiles: activeGroup?.paths ?? [] }).catch(() => {});
  }, [activeGroup?.paths, activeSession?.id]);

  const setActiveGroup = useCallback((id: string) => {
    update((s) => ({ ...s, activeGroupId: id }));
  }, [update]);

  const addGroup = useCallback((name: string): string => {
    const id = crypto.randomUUID();
    update((s) => ({
      groups: [...s.groups, { id, name: name.trim() || "group", paths: [] }],
      activeGroupId: id,
    }));
    return id;
  }, [update]);

  const removeGroup = useCallback((id: string) => {
    update((s) => {
      const groups = s.groups.filter((g) => g.id !== id);
      if (groups.length === 0) {
        const newId = crypto.randomUUID();
        return { groups: [{ id: newId, name: "main", paths: [] }], activeGroupId: newId };
      }
      const activeGroupId = s.activeGroupId === id ? groups[0].id : s.activeGroupId;
      return { groups, activeGroupId };
    });
  }, [update]);

  const renameGroup = useCallback((id: string, name: string) => {
    update((s) => ({
      ...s,
      groups: s.groups.map((g) => g.id === id ? { ...g, name: name.trim() || g.name } : g),
    }));
  }, [update]);

  const pinToActive = useCallback((path: string) => {
    update((s) => ({
      ...s,
      groups: s.groups.map((g) =>
        g.id === s.activeGroupId && !g.paths.includes(path)
          ? { ...g, paths: [...g.paths, path] }
          : g
      ),
    }));
  }, [update]);

  const pinToGroup = useCallback((groupId: string, path: string) => {
    update((s) => ({
      ...s,
      groups: s.groups.map((g) =>
        g.id === groupId && !g.paths.includes(path)
          ? { ...g, paths: [...g.paths, path] }
          : g
      ),
    }));
  }, [update]);

  const unpinFromActive = useCallback((path: string) => {
    update((s) => ({
      ...s,
      groups: s.groups.map((g) =>
        g.id === s.activeGroupId
          ? { ...g, paths: g.paths.filter((p) => p !== path) }
          : g
      ),
    }));
  }, [update]);

  const isFilePinned = useCallback((path: string): boolean => {
    return state.groups.some((g) => g.paths.includes(path));
  }, [state.groups]);

  return (
    <PinboardContext.Provider value={{
      groups: state.groups,
      activeGroupId: state.activeGroupId,
      activeGroup,
      setActiveGroup,
      addGroup,
      removeGroup,
      renameGroup,
      pinToActive,
      pinToGroup,
      unpinFromActive,
      isFilePinned,
    }}>
      {children}
    </PinboardContext.Provider>
  );
}
