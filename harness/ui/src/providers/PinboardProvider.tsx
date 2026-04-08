import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useProfiles } from "./ProfileContext";
import { API_BASE, authHeaders } from "../modusClient";
import { onUiEvent } from "../sessionStore";
import { PinboardContext, type PinGroup } from "./PinboardContext";

type PinboardState = {
  groups: PinGroup[];
  activeGroupId: string | null;
};

function defaultState(): PinboardState {
  const id = crypto.randomUUID();
  return { groups: [{ id, name: "main", paths: [] }], activeGroupId: id };
}

export function PinboardProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PinboardState>(() => defaultState());
  const { activeCwd } = useProfiles();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cwdRef = useRef(activeCwd);
  cwdRef.current = activeCwd;

  // Load from backend when cwd changes
  useEffect(() => {
    if (!activeCwd) return;
    fetch(`${API_BASE}/api/pinboards?cwd=${encodeURIComponent(activeCwd)}`, { headers: authHeaders() })
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((data: PinboardState) => {
        if (!data.groups || data.groups.length === 0) {
          setState(defaultState());
        } else {
          const activeGroupId = typeof data.activeGroupId === "string"
            && data.groups.find((g: PinGroup) => g.id === data.activeGroupId)
            ? data.activeGroupId : data.groups[0].id;
          setState({ groups: data.groups, activeGroupId });
        }
      })
      .catch(() => setState(defaultState()));
  }, [activeCwd]);

  // Debounced save to backend
  const persist = useCallback((next: PinboardState) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const cwd = cwdRef.current;
      if (!cwd) return;
      fetch(`${API_BASE}/api/pinboards?cwd=${encodeURIComponent(cwd)}`, {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(next),
      }).catch(() => {});
    }, 300);
  }, []);

  const update = useCallback((updater: (s: PinboardState) => PinboardState) => {
    setState((prev) => {
      const next = updater(prev);
      persist(next);
      return next;
    });
  }, [persist]);

  // Listen for backend "set-pins" UI events (agent-driven pin changes)
  useEffect(() => {
    return onUiEvent("set-pins", (_sessionId, event) => {
      if (Array.isArray(event.paths)) {
        // Reload from backend to get the authoritative state
        const cwd = cwdRef.current;
        if (!cwd) return;
        fetch(`${API_BASE}/api/pinboards?cwd=${encodeURIComponent(cwd)}`, { headers: authHeaders() })
          .then((r) => r.json())
          .then((data: PinboardState) => {
            if (data.groups && data.groups.length > 0) {
              setState(data);
            }
          })
          .catch(() => {});
      }
    });
  }, []);

  const activeGroup = state.groups.find((g) => g.id === state.activeGroupId) ?? null;

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
