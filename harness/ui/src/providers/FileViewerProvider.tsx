import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { onUiEvent } from "../sessionStore";
import { readFileContent, writeFileContent, onFsChange } from "../api";

type Tab = {
  path: string;
  pinned: boolean;
  editing: boolean;
  dirty: boolean;
  /** Loaded content for editing — null until first edit-mode load */
  content: string | null;
};

type FileViewerContextValue = {
  tabs: Tab[];
  activePath: string | null;
  openFile: (path: string, opts?: { edit?: boolean }) => void;
  closeFile: (path?: string) => void;
  pinFile: (path: string) => void;
  unpinFile: (path: string) => void;
  setActive: (path: string) => void;
  /** Toggle edit mode on/off for a tab */
  setEditing: (path: string, editing: boolean) => void;
  /** Mark a tab dirty (called by the editor on doc changes) */
  markDirty: (path: string) => void;
  /** Save a tab's content to disk */
  saveFile: (path: string, content: string) => Promise<boolean>;
  /** Restore saved state on session switch */
  hydrate: (tabs: Tab[], activePath: string | null) => void;
  /** Compat: single current path */
  path: string | null;
  /** Currently saving */
  saving: boolean;
  /** Last save error (auto-clears after 3s) */
  saveError: string | null;
  /** Increments when a viewed (non-editing) file changes on disk — triggers re-fetch */
  contentVersion: number;
};

const FileViewerContext = createContext<FileViewerContextValue>({
  tabs: [],
  activePath: null,
  openFile: () => {},
  closeFile: () => {},
  pinFile: () => {},
  unpinFile: () => {},
  setActive: () => {},
  setEditing: () => {},
  markDirty: () => {},
  saveFile: async () => false,
  hydrate: () => {},
  path: null,
  saving: false,
  saveError: null,
  contentVersion: 0,
});

export function useFileViewer() {
  return useContext(FileViewerContext);
}

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState(0);

  // ── Live refresh: bump contentVersion when a viewed (non-editing) file changes on disk ──
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    return onFsChange((event) => {
      const openTabs = tabsRef.current;
      if (!openTabs.length || !event.entry) return;
      const changedPath = `${event.dir}/${event.entry}`;
      const match = openTabs.find((t) => t.path === changedPath && !t.editing && !t.dirty);
      if (match) {
        setContentVersion((v) => v + 1);
      }
    });
  }, []);

  // Auto-clear save error
  useEffect(() => {
    if (!saveError) return;
    const t = setTimeout(() => setSaveError(null), 3000);
    return () => clearTimeout(t);
  }, [saveError]);

  const openFile = useCallback((path: string, opts?: { edit?: boolean }) => {
    const edit = opts?.edit ?? false;
    setTabs((prev) => {
      const existing = prev.find((t) => t.path === path);
      if (existing) {
        // If requesting edit mode on an existing view-only tab, upgrade it
        if (edit && !existing.editing) {
          return prev.map((t) => t.path === path ? { ...t, editing: true } : t);
        }
        return prev;
      }
      return [...prev, { path, pinned: false, editing: edit, dirty: false, content: null }];
    });
    setActivePath(path);

    // Pre-load content for edit mode
    if (edit) {
      readFileContent(path).then((text) => {
        if (text !== null) {
          setTabs((prev) => prev.map((t) =>
            t.path === path && t.content === null ? { ...t, content: text } : t
          ));
        }
      }).catch(() => {});
    }
  }, []);

  const closeFile = useCallback((path?: string) => {
    setActivePath((currentActive) => {
      if (!path && !currentActive) return currentActive;
      const target = path ?? currentActive!;
      setTabs((prev) => {
        const next = prev.filter((t) => t.path !== target);
        if (target === currentActive) {
          // Switch to last remaining tab, or null
          const fallback = next.length > 0 ? next[next.length - 1].path : null;
          // Use setTimeout to avoid nested setState
          setTimeout(() => setActivePath(fallback), 0);
        }
        return next;
      });
      return currentActive;
    });
  }, []);

  const pinFile = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, pinned: true } : t));
  }, []);

  const unpinFile = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, pinned: false } : t));
  }, []);

  const setActive = useCallback((path: string) => {
    setActivePath(path);
  }, []);

  const setEditing = useCallback((path: string, editing: boolean) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.path === path);
      if (!tab) return prev;
      return prev.map((t) => t.path === path ? { ...t, editing, dirty: editing ? t.dirty : false } : t);
    });
    // Load content when entering edit mode if not already loaded
    if (editing) {
      readFileContent(path).then((text) => {
        if (text !== null) {
          setTabs((prev) => prev.map((t) =>
            t.path === path && t.editing ? { ...t, content: text } : t
          ));
        }
      }).catch(() => {});
    }
  }, []);

  const markDirty = useCallback((path: string) => {
    setTabs((prev) => prev.map((t) => t.path === path ? { ...t, dirty: true } : t));
  }, []);

  const saveFile = useCallback(async (path: string, content: string): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    const ok = await writeFileContent(path, content);
    setSaving(false);
    if (ok) {
      setTabs((prev) => prev.map((t) =>
        t.path === path ? { ...t, dirty: false, content } : t
      ));
    } else {
      setSaveError("save failed");
    }
    return ok;
  }, []);

  const hydrate = useCallback((hydratedTabs: Array<{ path: string; pinned: boolean; editing?: boolean; dirty?: boolean; content?: string | null }>, hydratedActivePath: string | null) => {
    // Normalize old-shape tabs (from saved UI state) to full Tab shape
    setTabs(hydratedTabs.map((t) => ({
      path: t.path,
      pinned: t.pinned,
      editing: t.editing ?? false,
      dirty: false, // never restore dirty state — file may have changed
      content: null, // force re-load on edit
    })));
    setActivePath(hydratedActivePath);
  }, []);

  // Listen for backend "open-file" UI events
  useEffect(() => {
    return onUiEvent("open-file", (_sessionId, event) => {
      if (typeof event.path === "string") {
        openFile(event.path, { edit: !!event.edit });
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
        setEditing,
        markDirty,
        saveFile,
        hydrate,
        path: activePath,
        saving,
        saveError,
        contentVersion,
      }}
    >
      {children}
    </FileViewerContext.Provider>
  );
}
