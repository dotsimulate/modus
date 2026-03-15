import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import { onUiEvent } from "../sessionStore";

type Tab = {
  path: string;
  pinned: boolean;
};

type FileViewerContextValue = {
  tabs: Tab[];
  activePath: string | null;
  openFile: (path: string) => void;
  closeFile: (path?: string) => void;
  pinFile: (path: string) => void;
  unpinFile: (path: string) => void;
  setActive: (path: string) => void;
  /** Compat: single current path */
  path: string | null;
};

const FileViewerContext = createContext<FileViewerContextValue>({
  tabs: [],
  activePath: null,
  openFile: () => {},
  closeFile: () => {},
  pinFile: () => {},
  unpinFile: () => {},
  setActive: () => {},
  path: null,
});

export function useFileViewer() {
  return useContext(FileViewerContext);
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);

  const openFile = useCallback((path: string) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      return [...prev, { path, pinned: false }];
    });
    setActivePath(path);
  }, []);

  const closeFile = useCallback((path?: string) => {
    if (!path && !activePath) return;
    const target = path ?? activePath!;
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== target);
      // If closing the active tab, switch to the last remaining tab
      if (target === activePath) {
        setActivePath(next.length > 0 ? next[next.length - 1].path : null);
      }
      return next;
    });
  }, [activePath]);

  const pinFile = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, pinned: true } : t));
  }, []);

  const unpinFile = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, pinned: false } : t));
  }, []);

  const setActive = useCallback((path: string) => {
    setActivePath(path);
  }, []);

  // Listen for backend "open-file" UI events
  useEffect(() => {
    return onUiEvent("open-file", (_sessionId, event) => {
      if (typeof event.path === "string") {
        openFile(event.path);
      }
    });
  }, [openFile]);

  return (
    <FileViewerContext.Provider
      value={{
        tabs,
        activePath,
        openFile,
        closeFile,
        pinFile,
        unpinFile,
        setActive,
        path: activePath,
      }}
    >
      {children}
    </FileViewerContext.Provider>
  );
}
