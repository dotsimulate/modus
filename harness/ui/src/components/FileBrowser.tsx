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

import { useState, useEffect, useMemo, useCallback } from "react";
import { browsePath, readFileContent, openInEditor, type BrowseResult } from "../api";
import { FileContentViewer } from "./FileContentViewer";

type FileBrowserProps = {
  /** Starting directory path */
  rootPath: string | null;
  /** Compact mode for sidebar — shorter list, no file preview */
  compact?: boolean;
  /** Called when a file is selected (path) */
  onFileSelect?: (path: string) => void;
  /** Called when user wants to open file externally */
  onOpenExternal?: (path: string) => void;
};

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "directory"; result: BrowseResult & { files?: string[] } }
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

export function FileBrowser({ rootPath, compact, onFileSelect, onOpenExternal }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string | null>(rootPath);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [fileView, setFileView] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);

  // Sync rootPath changes
  useEffect(() => {
    setCurrentPath(rootPath);
  }, [rootPath]);

  // Load directory listing
  useEffect(() => {
    if (!currentPath) { setView({ kind: "idle" }); return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const result = await browsePath(currentPath, { includeHidden: false });
        // Also try to get files in the directory
        const fullResult = await browsePathWithFiles(currentPath);
        if (active) setView({ kind: "directory", result: { ...result, files: fullResult.files } });
      } catch {
        if (active) setView({ kind: "error", message: "Could not browse this path." });
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [currentPath]);

  const navigateTo = useCallback((path: string) => {
    setCurrentPath(path);
    setFileView(null);
  }, []);

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
      <div className="fb-list">
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
              <button key={d.path} className="fb-entry fb-entry--dir" onClick={() => navigateTo(d.path)}>
                <span className="fb-entry-icon">
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1" fill="none"/>
                  </svg>
                </span>
                <span className="fb-entry-name">{d.name}</span>
              </button>
            ))}
            {entries.files.map((f) => (
              <button key={f.path} className="fb-entry fb-entry--file" onClick={() => openFile(f.path)}>
                <span className="fb-entry-icon">
                  <svg width="9" height="10" viewBox="0 0 10 12" fill="none">
                    <path d="M1 1h5l3 3v7H1z" stroke="currentColor" strokeWidth="1" fill="none"/>
                    <path d="M6 1v3h3" stroke="currentColor" strokeWidth="0.8" fill="none"/>
                  </svg>
                </span>
                <span className="fb-entry-name">{f.name}</span>
              </button>
            ))}
            {entries.dirs.length === 0 && entries.files.length === 0 && (
              <div className="fb-state">empty directory</div>
            )}
          </>
        )}
      </div>

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

/**
 * Extended browse that also returns files (not just dirs).
 * The standard /api/browse only returns dirs. We augment with file-read attempt.
 */
async function browsePathWithFiles(dirPath: string): Promise<{ files: string[] }> {
  try {
    // Use the browse API but also request file listing
    const res = await fetch(
      `/api/browse?path=${encodeURIComponent(dirPath)}&includeHidden=0&includeFiles=1`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return { files: [] };
    const data = await res.json();
    return { files: data.files ?? [] };
  } catch {
    return { files: [] };
  }
}
