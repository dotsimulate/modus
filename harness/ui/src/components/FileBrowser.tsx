/**
 * FileBrowser — tree-style file/folder browser component.
 *
 * Renders an expandable folder tree rooted at `rootPath`.
 * Folders expand/collapse inline with lazy loading via /api/browse.
 *
 * Usable in:
 *   - Sidebar widgets (compact mode)
 *   - Full-page productivity view
 *   - Any container that needs file navigation
 */

import { useState, useEffect, useCallback, useRef, forwardRef, useImperativeHandle } from "react";
import { modus } from "../modusClient";
import type { BrowseResult } from "../../../sdk/index";
import { onFsChange } from "../modusClient";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { usePinboard } from "../providers/PinboardContext";
import {
  FileText, FileCode2, FileJson, FileImage, FileVideo, FileAudio,
  FileType, FileArchive, FileLock, FileTerminal, FileCog,
  File as FileGeneric
} from "lucide-react";

type FileBrowserProps = {
  /** Starting directory path */
  rootPath: string | null;
  /** Override the initial browse path (e.g. restored from session state) */
  initialPath?: string | null;
  /** Compact mode for sidebar — shorter list, no file preview */
  compact?: boolean;
  /** Hide the built-in breadcrumb header (parent owns it) */
  hideHeader?: boolean;
  /** Called when a file is selected (path) */
  onFileSelect?: (path: string) => void;
  /** Called when user wants to open file externally */
  onOpenExternal?: (path: string) => void;
  /** Called whenever the current browse path changes */
  onPathChange?: (path: string) => void;
};

export type FileBrowserHandle = {
  collapseAll: () => void;
  revealPath: (path: string) => void;
};

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

// ── Icons ──

const chevronIcon = (open: boolean) => (
  <svg width="6" height="6" viewBox="0 0 6 6" fill="none" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s ease" }}>
    <path d="M1.5 0.5L4.5 3L1.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const ICON_SIZE = 11;
const ICON_STROKE = 1.5;

function fileIconFor(name: string) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";

  let Icon = FileGeneric;
  let color = "var(--text-muted)";

  if (["ts", "tsx"].includes(ext))                        { Icon = FileCode2;    color = "#3178c6"; }
  else if (["js", "jsx", "mjs", "cjs"].includes(ext))    { Icon = FileCode2;    color = "#c8a82e"; }
  else if (["py"].includes(ext))                          { Icon = FileCode2;    color = "#4b8bbe"; }
  else if (["rs"].includes(ext))                          { Icon = FileCode2;    color = "#ce422b"; }
  else if (["go"].includes(ext))                          { Icon = FileCode2;    color = "#00add8"; }
  else if (["c", "cpp", "h", "hpp"].includes(ext))       { Icon = FileCode2;    color = "#5c6bc0"; }
  else if (["java", "kt"].includes(ext))                  { Icon = FileCode2;    color = "#b07219"; }
  else if (["rb"].includes(ext))                          { Icon = FileCode2;    color = "#cc342d"; }
  else if (["css", "scss", "less"].includes(ext))         { Icon = FileCode2;    color = "#569cd6"; }
  else if (["html", "htm"].includes(ext))                 { Icon = FileCode2;    color = "#c66d3e"; }
  else if (["json", "jsonc"].includes(ext))               { Icon = FileJson;     color = "#8a8a2a"; }
  else if (["md", "mdx"].includes(ext))                   { Icon = FileText;     color = "#6a9955"; }
  else if (["txt", "log"].includes(ext))                  { Icon = FileText;     color = "var(--text-muted)"; }
  else if (["sh", "bash", "zsh", "fish"].includes(ext))   { Icon = FileTerminal; color = "#89e051"; }
  else if (["yaml", "yml", "toml", "ini"].includes(ext)) { Icon = FileCog;      color = "#8b7daa"; }
  else if (["svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "avif", "bmp", "tiff"].includes(ext)) { Icon = FileImage; color = "#a874a0"; }
  else if (["mp4", "webm", "mkv", "avi", "mov"].includes(ext)) { Icon = FileVideo; color = "#c66d9e"; }
  else if (["mp3", "wav", "ogg", "flac", "aac"].includes(ext)) { Icon = FileAudio; color = "#e0a040"; }
  else if (["zip", "tar", "gz", "bz2", "xz", "7z", "rar"].includes(ext)) { Icon = FileArchive; color = "#8b6914"; }
  else if (["lock"].includes(ext))                        { Icon = FileLock;     color = "var(--text-muted)"; }
  else if (["woff", "woff2", "ttf", "otf", "eot"].includes(ext)) { Icon = FileType; color = "var(--text-muted)"; }

  return (
    <span className="fb-file-icon" aria-hidden>
      <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} color={color} />
    </span>
  );
}

const pinIcon = (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
    <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none"/>
    <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

const homeIcon = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
    <path d="M1.5 6L6 1.5L10.5 6M3 5v5.5h2.25V8h1.5v2.5H9V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const externalIcon = (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
    <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

export const FileBrowser = forwardRef<FileBrowserHandle, FileBrowserProps>(function FileBrowser(
  { rootPath, initialPath: _initialPath, compact, hideHeader, onFileSelect, onOpenExternal, onPathChange: _onPathChange },
  ref,
) {
  const { groups, pinToGroup, unpinFromActive } = usePinboard();
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const init = new Set<string>();
    if (rootPath) init.add(rootPath);
    return init;
  });
  const [dirCache, setDirCache] = useState<Map<string, BrowseResult>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [revealedPath, setRevealedPath] = useState<string | null>(null);
  const dirCacheRef = useRef<Map<string, BrowseResult>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);
  const revealTimerRef = useRef<number | null>(null);

  useEffect(() => { dirCacheRef.current = dirCache; }, [dirCache]);

  // ── Context menu ──
  const ctxMenu = useContextMenu();
  const [ctxTarget, setCtxTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!ctxMenu.isOpen) setCtxTarget(null);
  }, [ctxMenu.isOpen]);

  const openCtx = useCallback((e: React.MouseEvent, items: ContextMenuItem[], targetPath?: string) => {
    setCtxTarget(targetPath ?? null);
    ctxMenu.open(e, items);
  }, [ctxMenu]);

  // ── Create file/folder ──
  const [creating, setCreating] = useState<{ kind: "file" | "dir"; dir: string } | null>(null);
  const [createName, setCreateName] = useState("");
  const createInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) {
      setCreateName("");
      requestAnimationFrame(() => createInputRef.current?.focus());
    }
  }, [creating]);

  // ── Directory fetching ──
  const fetchDir = useCallback(async (dirPath: string): Promise<BrowseResult | null> => {
    setLoadingDirs((s) => new Set(s).add(dirPath));
    try {
      const result = await modus.browse(dirPath, { includeHidden: true, includeFiles: true });
      setDirCache((m) => new Map(m).set(dirPath, result));
      dirCacheRef.current = new Map(dirCacheRef.current).set(dirPath, result);
      return result;
    } catch {
      return null;
    } finally {
      setLoadingDirs((s) => { const n = new Set(s); n.delete(dirPath); return n; });
    }
  }, []);

  // Load root on mount / rootPath change
  const prevRootRef = useRef<string | null>(null);
  useEffect(() => {
    if (!rootPath) return;
    if (rootPath !== prevRootRef.current) {
      prevRootRef.current = rootPath;
      setExpanded(new Set([rootPath]));
      setDirCache(new Map());
      fetchDir(rootPath);
    }
  }, [rootPath, fetchDir]);

  // ── Live refresh via fs-watcher events ──
  useEffect(() => {
    return onFsChange((event) => {
      // Only refresh directories we already have cached (i.e. expanded)
      setDirCache((cache) => {
        if (cache.has(event.dir)) {
          // Re-fetch this directory in the background
          modus.browse(event.dir, { includeHidden: true, includeFiles: true })
            .then((result) => setDirCache((m) => new Map(m).set(event.dir, result)))
            .catch(() => {});
        }
        return cache;
      });
    });
  }, []);

  const toggleDir = useCallback((dirPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        if (!dirCache.has(dirPath)) fetchDir(dirPath);
      }
      return next;
    });
  }, [dirCache, fetchDir]);

  const collapseAll = useCallback(() => {
    if (!rootPath) return;
    setExpanded(new Set([rootPath]));
  }, [rootPath]);

  const revealPath = useCallback(async (target: string) => {
    if (!rootPath || !target) return;
    const normTarget = target.replace(/\\/g, "/");
    const normRoot = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (!normTarget.startsWith(normRoot + "/") && normTarget !== normRoot) return;

    // Build parent chain (all dirs from root up to and including the target's parent)
    const rel = normTarget === normRoot ? "" : normTarget.slice(normRoot.length + 1);
    const parts = rel ? rel.split("/") : [];
    // Reconstruct paths using the same separator the tree uses internally (`/` joins off rootPath as-is)
    const dirs: string[] = [rootPath];
    let cur = rootPath;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = `${cur}/${parts[i]}`;
      dirs.push(cur);
    }

    // Expand all parent dirs at once
    setExpanded((prev) => {
      const n = new Set(prev);
      dirs.forEach((d) => n.add(d));
      return n;
    });

    // Fetch any uncached parents in order so children resolve before we scroll
    for (const dir of dirs) {
      if (!dirCacheRef.current.has(dir)) {
        await fetchDir(dir);
      }
    }

    // Give React a frame to render the newly-expanded nodes, then scroll + flash
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = listRef.current;
        if (!container) return;
        const safe = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
          ? CSS.escape(target)
          : target.replace(/["\\]/g, "\\$&");
        const el = container.querySelector<HTMLElement>(`[data-path="${safe}"]`);
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        }
        setRevealedPath(target);
        if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
        revealTimerRef.current = window.setTimeout(() => {
          setRevealedPath((p) => (p === target ? null : p));
          revealTimerRef.current = null;
        }, 1400);
      });
    });
  }, [rootPath, fetchDir]);

  useEffect(() => () => {
    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
  }, []);

  useImperativeHandle(ref, () => ({ collapseAll, revealPath }), [collapseAll, revealPath]);

  const openFile = useCallback((path: string) => {
    onFileSelect?.(path);
  }, [onFileSelect]);

  const handleOpenExternal = useCallback((path: string) => {
    if (onOpenExternal) onOpenExternal(path);
    else modus.openInEditor(path);
  }, [onOpenExternal]);

  const refreshDir = useCallback((dirPath: string) => {
    fetchDir(dirPath);
  }, [fetchDir]);

  const handleCreate = useCallback(async () => {
    if (!creating || !createName.trim()) { setCreating(null); return; }
    const target = `${creating.dir}/${createName.trim()}`;
    const ok = creating.kind === "file"
      ? await modus.createFile(target)
      : await modus.createDirectory(target);
    setCreating(null);
    if (ok) {
      refreshDir(creating.dir);
      if (creating.kind === "file") onFileSelect?.(target);
    }
  }, [creating, createName, onFileSelect, refreshDir]);

  // ── Context menu builders ──
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

  const relativeTo = useCallback((path: string): string => {
    if (!rootPath) return path;
    const norm = path.replace(/\\/g, "/");
    const root = rootPath.replace(/\\/g, "/").replace(/\/$/, "");
    if (norm === root) return "";
    if (norm.startsWith(root + "/")) return norm.slice(root.length + 1);
    return path;
  }, [rootPath]);

  const buildFileItems = useCallback((path: string): ContextMenuItem[] => [
    { kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(path) },
    { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(path) },
    { kind: "separator" },
    { kind: "action", label: "Copy name", onClick: () => navigator.clipboard.writeText(basename(path)) },
    { kind: "action", label: "Copy relative path", onClick: () => navigator.clipboard.writeText(relativeTo(path)) },
    { kind: "action", label: "Copy absolute path", onClick: () => navigator.clipboard.writeText(path) },
    { kind: "separator" },
    ...buildPinItems(path),
  ], [handleOpenExternal, buildPinItems, relativeTo]);

  const buildDirItems = useCallback((dirPath: string): ContextMenuItem[] => [
    { kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(dirPath) },
    { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(dirPath) },
    { kind: "separator" },
    { kind: "action", label: "New file...", onClick: () => setCreating({ kind: "file", dir: dirPath }) },
    { kind: "action", label: "New folder...", onClick: () => setCreating({ kind: "dir", dir: dirPath }) },
    { kind: "separator" },
    { kind: "action", label: "Copy name", onClick: () => navigator.clipboard.writeText(basename(dirPath)) },
    { kind: "action", label: "Copy relative path", onClick: () => navigator.clipboard.writeText(relativeTo(dirPath)) },
    { kind: "action", label: "Copy absolute path", onClick: () => navigator.clipboard.writeText(dirPath) },
    { kind: "separator" },
    { kind: "action", label: "Refresh", onClick: () => refreshDir(dirPath) },
  ], [handleOpenExternal, refreshDir, relativeTo]);

  const buildBgItems = useCallback((): ContextMenuItem[] => {
    if (!rootPath) return [];
    return [
      { kind: "action", label: "New file...", onClick: () => setCreating({ kind: "file", dir: rootPath }) },
      { kind: "action", label: "New folder...", onClick: () => setCreating({ kind: "dir", dir: rootPath }) },
      { kind: "separator" },
      { kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(rootPath) },
      { kind: "action", label: "Open in editor", onClick: () => handleOpenExternal(rootPath) },
      { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(rootPath) },
      { kind: "action", label: "Refresh", onClick: () => refreshDir(rootPath) },
      { kind: "separator" },
      { kind: "action", label: "Collapse all", onClick: collapseAll },
    ];
  }, [rootPath, handleOpenExternal, refreshDir, collapseAll]);

  // ── Tree node renderer ──
  const INDENT = 14;

  const renderDir = (dirPath: string, depth: number) => {
    const isExpanded = expanded.has(dirPath);
    const cached = dirCache.get(dirPath);
    const isLoading = loadingDirs.has(dirPath);
    const name = basename(dirPath);
    const isRoot = dirPath === rootPath;
    const childDepth = isRoot ? depth : depth + 1;

    return (
      <div key={dirPath}>
        {!isRoot && (
          <button
            className={`fb-entry fb-entry--dir${ctxTarget === dirPath ? " fb-entry--ctx" : ""}${isExpanded ? " fb-entry--open" : ""}${revealedPath === dirPath ? " fb-entry--revealed" : ""}`}
            data-path={dirPath}
            style={{ paddingLeft: 8 + depth * INDENT, top: 0, zIndex: 10 - depth }}
            onClick={() => toggleDir(dirPath)}
            onContextMenu={(e) => openCtx(e, buildDirItems(dirPath), dirPath)}
          >
            <span className="fb-entry-chevron">{chevronIcon(isExpanded)}</span>
            <span className="fb-entry-name">{name}</span>
          </button>
        )}
        {isExpanded && cached && (
          <div className={isRoot ? undefined : "fb-group"} style={isRoot ? undefined : { "--guide-left": `${depth * INDENT + 11}px` } as React.CSSProperties}>
            {cached.dirs.map((sub) => renderDir(`${dirPath}/${sub}`, childDepth))}
            {(cached.files ?? []).map((fname) => {
              const fpath = `${dirPath}/${fname}`;
              return (
                <button
                  key={fpath}
                  className={`fb-entry fb-entry--file${ctxTarget === fpath ? " fb-entry--ctx" : ""}${revealedPath === fpath ? " fb-entry--revealed" : ""}`}
                  data-path={fpath}
                  style={{ paddingLeft: childDepth * INDENT + 8 }}
                  onClick={() => openFile(fpath)}
                  onContextMenu={(e) => openCtx(e, buildFileItems(fpath), fpath)}
                >
                  {fileIconFor(fname)}
                  <span className="fb-entry-name">{fname}</span>
                </button>
              );
            })}
            {creating && creating.dir === dirPath && (
              <div className="ctx-menu-input-row" style={{ paddingLeft: childDepth * INDENT + 8 }}>
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
          </div>
        )}
        {isExpanded && isLoading && (
          <div className="fb-state" style={{ paddingLeft: 8 + childDepth * INDENT, textAlign: "left" }}>loading...</div>
        )}
      </div>
    );
  };

  if (!rootPath) {
    return <div className="fb-empty">no project path</div>;
  }

  return (
    <div className={`file-browser${compact ? " file-browser--compact" : ""}`}>
      {!hideHeader && (
        <div className="fb-breadcrumb">
          <span className="fb-breadcrumb-path">{basename(rootPath)}</span>
          <div className="fb-breadcrumb-actions">
            <button className="fb-btn" onClick={collapseAll} title="Collapse all">
              {homeIcon}
            </button>
            <button className="fb-btn" onClick={() => modus.openInFolder(rootPath)} title="Open in file explorer">
              {externalIcon}
            </button>
          </div>
        </div>
      )}

      {/* Tree */}
      <div
        ref={listRef}
        className="fb-list"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("fb-state"))
            ctxMenu.open(e, buildBgItems());
        }}
      >
        {rootPath && renderDir(rootPath, 0)}
      </div>
      {ctxMenu.portal}
    </div>
  );
});
