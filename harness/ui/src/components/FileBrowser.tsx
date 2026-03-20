/**
 * FileBrowser — modular file/folder browser component.
 *
 * Standalone component that browses directories and previews file content.
 * Uses the existing /api/browse and /api/file-read endpoints.
 *
 * Usable in:
 *   - Sidebar widgets (compact mode)
 *   - Full-page productivity view
 *   - Any container that needs file navigation
 */

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { browsePath, readFileContent, openInEditor, createFile, createDirectory, type BrowseResult } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { usePinboard } from "../providers/PinboardProvider";

type FileBrowserProps = {
  /** Starting directory path */
  rootPath: string | null;
  /** Override the initial browse path (e.g. restored from session state) */
  initialPath?: string | null;
  /** Compact mode for sidebar — shorter list, no file preview */
  compact?: boolean;
  /** Called when a file is selected (path) */
  onFileSelect?: (path: string) => void;
  /** Called when user wants to open file externally */
  onOpenExternal?: (path: string) => void;
  /** Called whenever the current browse path changes */
  onPathChange?: (path: string) => void;
};

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "directory"; result: BrowseResult }
  | { kind: "file"; path: string; content: string }
  | { kind: "error"; message: string };

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function shortenPath(full: string, root: string | null): string {
  if (!root) return full;
  if (full.startsWith(root)) {
    const rel = full.slice(root.length).replace(/^\//, "");
    return rel || "/";
  }
  return full;
}

export function FileBrowser({ rootPath, initialPath, compact, onFileSelect, onOpenExternal, onPathChange }: FileBrowserProps) {
  const { groups, pinToActive, pinToGroup, unpinFromActive, isFilePinned, activeGroup } = usePinboard();
  const [currentPath, setCurrentPath] = useState<string | null>(initialPath ?? rootPath);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [fileView, setFileView] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Only reset to rootPath when rootPath itself changes (project switch), not on every render
  const prevRootRef = useRef<string | null>(rootPath);
  useEffect(() => {
    if (rootPath !== prevRootRef.current) {
      prevRootRef.current = rootPath;
      setCurrentPath(rootPath);
    }
  }, [rootPath]);

  // Load directory listing
  useEffect(() => {
    if (!currentPath) { setView({ kind: "idle" }); return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const result = await browsePath(currentPath, { includeHidden: false, includeFiles: true });
        if (active) setView({ kind: "directory", result });
      } catch {
        if (active) setView({ kind: "error", message: "Could not browse this path." });
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [currentPath]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setFileView(null);
    onPathChange?.(path);
  }, [onPathChange]);

  const openFile = useCallback(async (path: string) => {
    onFileSelect?.(path);
    if (compact) return; // compact mode delegates to parent
    try {
      const content = await readFileContent(path);
      if (content !== null) {
        setFileView({ path, content });
      }
    } catch {
      setFileView({ path, content: "Could not read file." });
    }
  }, [compact, onFileSelect]);

  const handleOpenExternal = useCallback((path: string) => {
    if (onOpenExternal) {
      onOpenExternal(path);
    } else {
      openInEditor(path);
    }
  }, [onOpenExternal]);

  // ── Context menu ──
  const ctxMenu = useContextMenu();
  const [ctxTarget, setCtxTarget] = useState<string | null>(null);

  // Clear highlight when context menu closes
  useEffect(() => {
    if (!ctxMenu.isOpen) setCtxTarget(null);
  }, [ctxMenu.isOpen]);

  const openCtx = useCallback((e: React.MouseEvent, items: ContextMenuItem[], targetPath?: string) => {
    setCtxTarget(targetPath ?? null);
    ctxMenu.open(e, items);
  }, [ctxMenu]);

  const [creating, setCreating] = useState<{ kind: "file" | "dir"; dir: string } | null>(null);
  const [createName, setCreateName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      setCreateName("");
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [creating]);

  const handleCreate = useCallback(async () => {
    if (!creating || !createName.trim()) { setCreating(null); return; }
    const target = `${creating.dir}/${createName.trim()}`;
    const ok = creating.kind === "file"
      ? await createFile(target)
      : await createDirectory(target);
    setCreating(null);
    if (ok) {
      // Refresh the listing
      setCurrentPath((p) => { setCurrentPath(null); return null; });
      requestAnimationFrame(() => setCurrentPath(creating.dir));
      if (creating.kind === "file") onFileSelect?.(target);
    }
  }, [creating, createName, onFileSelect]);

  const reload = useCallback(() => {
    if (!currentPath) return;
    const p = currentPath;
    setCurrentPath(null);
    requestAnimationFrame(() => setCurrentPath(p));
  }, [currentPath]);

  const pinIcon = (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
      <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none"/>
      <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );

  const buildPinItems = useCallback((path: string): ContextMenuItem[] => {
    return groups.map((g) => {
      const pinned = g.paths.includes(path);
      return {
        kind: "action" as const,
        icon: pinIcon,
        label: pinned ? `Unpin from ${g.name}` : `Pin to ${g.name}`,
        onClick: () => { if (pinned) unpinFromActive(path); else pinToGroup(g.id, path); },
      };
    });
  }, [groups, pinToGroup, unpinFromActive]);

  const buildFileItems = useCallback((path: string): ContextMenuItem[] => [
    { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(path) },
    { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(path) },
    { kind: "separator" },
    ...buildPinItems(path),
  ], [handleOpenExternal, buildPinItems]);

  const buildDirItems = useCallback((path: string): ContextMenuItem[] => [
    { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(path) },
    { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(path) },
    { kind: "separator" },
    { kind: "action", label: "New file...", onClick: () => setCreating({ kind: "file", dir: path }) },
    { kind: "action", label: "New folder...", onClick: () => setCreating({ kind: "dir", dir: path }) },
  ], [handleOpenExternal]);

  const buildBgItems = useCallback((): ContextMenuItem[] => {
    const dir = view.kind === "directory" ? view.result.path : currentPath;
    if (!dir) return [];
    return [
      { kind: "action", label: "New file...", onClick: () => setCreating({ kind: "file", dir }) },
      { kind: "action", label: "New folder...", onClick: () => setCreating({ kind: "dir", dir }) },
      { kind: "separator" },
      { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(dir) },
      { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(dir) },
      { kind: "action", label: "Refresh", onClick: reload },
    ];
  }, [view, currentPath, handleOpenExternal, reload]);

  const entries = useMemo(() => {
    if (view.kind !== "directory") return { dirs: [], files: [] };
    const dirs = view.result.dirs.map((name) => ({
      name,
      path: `${view.result.path}/${name}`,
      kind: "dir" as const,
    }));
    const files = (view.result.files ?? []).map((name) => ({
      name,
      path: `${view.result.path}/${name}`,
      kind: "file" as const,
    }));
    return { dirs, files };
  }, [view]);

  if (!rootPath) {
    return <div className="fb-empty">no project path</div>;
  }

  return (
    <div className={`file-browser${compact ? " file-browser--compact" : ""}`}>
      {/* Breadcrumb / current path */}
      {view.kind === "directory" && (
        <div className="fb-breadcrumb">
          <span className="fb-breadcrumb-path">{shortenPath(view.result.path, rootPath)}</span>
          <div className="fb-breadcrumb-actions">
            <button
              className="fb-btn"
              onClick={() => handleOpenExternal(view.result.path)}
              title="Open in editor"
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Directory listing */}
      <div className="fb-list" onContextMenu={(e) => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("fb-state")) ctxMenu.open(e, buildBgItems()); }}>
        {loading && <div className="fb-state">loading...</div>}
        {view.kind === "error" && <div className="fb-state">{view.message}</div>}

        {view.kind === "directory" && (
          <>
            {view.result.parent && (
              <button className="fb-entry fb-entry--parent" onClick={() => navigateTo(view.result.parent!)}>
                <span className="fb-entry-icon">..</span>
                <span className="fb-entry-name">parent</span>
              </button>
            )}
            {entries.dirs.map((d) => (
              <button key={d.path} className={`fb-entry fb-entry--dir${ctxTarget === d.path ? " fb-entry--ctx" : ""}`} onClick={() => navigateTo(d.path)} onContextMenu={(e) => openCtx(e, buildDirItems(d.path), d.path)}>
                <span className="fb-entry-icon">
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1" fill="none"/>
                  </svg>
                </span>
                <span className="fb-entry-name">{d.name}</span>
              </button>
            ))}
            {entries.files.map((f) => (
              <button key={f.path} className={`fb-entry fb-entry--file${ctxTarget === f.path ? " fb-entry--ctx" : ""}`} onClick={() => openFile(f.path)} onContextMenu={(e) => openCtx(e, buildFileItems(f.path), f.path)}>
                <span className="fb-entry-icon">
                  <svg width="9" height="10" viewBox="0 0 10 12" fill="none">
                    <path d="M1 1h5l3 3v7H1z" stroke="currentColor" strokeWidth="1" fill="none"/>
                    <path d="M6 1v3h3" stroke="currentColor" strokeWidth="0.8" fill="none"/>
                  </svg>
                </span>
                <span className="fb-entry-name">{f.name}</span>
              </button>
            ))}
            {entries.dirs.length === 0 && entries.files.length === 0 && !creating && (
              <div className="fb-state">empty directory</div>
            )}
            {/* Inline creation row */}
            {creating && (
              <div className="ctx-menu-input-row">
                <span style={{ fontSize: 10, opacity: 0.5 }}>{creating.kind === "file" ? "file:" : "dir:"}</span>
                <input
                  ref={createInputRef}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                    if (e.key === "Escape") setCreating(null);
                  }}
                  onBlur={handleCreate}
                  placeholder={creating.kind === "file" ? "filename" : "folder name"}
                />
              </div>
            )}
          </>
        )}
      </div>
      {ctxMenu.portal}

      {/* File preview (non-compact only) */}
      {!compact && fileView && (
        <div className="fb-preview">
          <FileContentViewer
            filePath={fileView.path}
            content={fileView.content}
            loading={false}
            actions={
              <>
                <button className="fb-btn" onClick={() => handleOpenExternal(fileView.path)} title="Open in editor">
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                <button className="fb-btn" onClick={() => setFileView(null)} title="Close preview">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                </button>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

