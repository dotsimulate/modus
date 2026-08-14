import { useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { onUiEvent } from "../sessionStore";
import { modus } from "../modusClient";
import { onFsChange } from "../modusClient";
import { FileViewerContext, type FileOpenRequest, type Tab } from "./FileViewerContext";

export function FileViewerProvider({ children }: { children: ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [contentVersion, setContentVersion] = useState(0);

  // ── Live refresh: bump contentVersion when a viewed (non-editing) file changes on disk ──
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const fileOpenListenersRef = useRef<Set<(request: FileOpenRequest) => void>>(new Set());
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

  const openFile = useCallback((path: string, opts?: Omit<FileOpenRequest, "path">) => {
    const request: FileOpenRequest = { path, ...opts };
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

    // Notify panel-open listeners on every open so re-clicks can re-focus the
    // code-editor tab even when the file is already in the tab strip.
    fileOpenListenersRef.current.forEach((fn) => fn(request));

    // Pre-load content for edit mode
    if (edit) {
      modus.readFile(path).then((text) => {
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
      modus.readFile(path).then((text) => {
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
    const saved = await modus.writeFile(path, content);
    setSaving(false);
    if (saved.ok) {
      setTabs((prev) => prev.map((t) =>
        t.path === path ? { ...t, dirty: false, content } : t
      ));
    } else {
      // "save failed" gave the user nothing to act on. A read-only volume and a
      // permission problem need different responses from them.
      setSaveError(saved.error ?? "save failed");
    }
    return saved.ok;
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

  const subscribeFileOpens = useCallback((fn: (request: FileOpenRequest) => void) => {
    fileOpenListenersRef.current.add(fn);
    return () => { fileOpenListenersRef.current.delete(fn); };
  }, []);

  // Listen for backend "open-file" UI events
  useEffect(() => {
    return onUiEvent("open-file", (_sessionId, event) => {
      if (typeof event.path === "string") {
        openFile(event.path, {
          edit: !!event.edit,
          line: typeof event.line === "number" ? event.line : undefined,
          endLine: typeof event.endLine === "number" ? event.endLine : undefined,
          highlight: typeof event.highlight === "boolean" ? event.highlight : undefined,
          source: "ui-event",
        });
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
        subscribeFileOpens,
      }}
    >
      {children}
    </FileViewerContext.Provider>
  );
}
