import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useFileViewer } from "../providers/FileViewerProvider";
import { browsePath, openInEditor, readFileContent, type BrowseResult } from "../api";
import { FileContentViewer } from "./FileContentViewer";

type Props = {
  open: boolean;
  width: number;
  onOpen: () => void;
  onClose: () => void;
  children?: ReactNode;
};

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function isHtmlFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "file"; content: string }
  | { kind: "directory"; result: BrowseResult }
  | { kind: "error"; message: string };

export function RightPanel({ open, width, onOpen, onClose, children }: Props) {
  const { path, closeFile } = useFileViewer();

  const [activePath, setActivePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [copiedPath, setCopiedPath] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState(true); // default to preview for HTML
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    setActivePath(path);
    if (path) onOpen();
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activePath) { setView({ kind: "idle" }); return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const dirResult = await browsePath(activePath, { includeHidden: true });
        if (active) setView({ kind: "directory", result: dirResult });
        return;
      } catch {
        try {
          const text = await readFileContent(activePath);
          if (!active) return;
          if (text !== null) { setView({ kind: "file", content: text }); return; }
        } catch { /* fall through */ }
        if (active) setView({ kind: "error", message: "Could not load this path." });
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [activePath]);

  // Reset preview mode when switching files
  useEffect(() => {
    if (activePath) {
      setCopiedPath(false);
      setHtmlPreview(true);
    }
  }, [activePath]);

  useEffect(() => {
    if (!copiedPath) return;
    const t = window.setTimeout(() => setCopiedPath(false), 1000);
    return () => window.clearTimeout(t);
  }, [copiedPath]);

  const directoryEntries = useMemo(() => {
    if (view.kind !== "directory") return [];
    return view.result.dirs.map((dir) => ({
      key: `dir:${dir}`,
      name: dir,
      path: `${view.result.path}/${dir}`,
    }));
  }, [view]);

  const handleClose = () => {
    setFullscreen(false);
    onClose();
    closeFile();
  };

  const handleCloseFile = () => {
    setFullscreen(false);
    closeFile();
    setActivePath(null);
    setView({ kind: "idle" });
  };

  const copyBtn = (targetPath: string) => (
    <button
      className={`chat-file-viewer-btn chat-file-viewer-btn--inline${copiedPath ? " is-copied" : ""}`}
      onClick={() => navigator.clipboard.writeText(targetPath).then(() => setCopiedPath(true)).catch(() => {})}
      title={copiedPath ? "Copied" : "Copy path"}
    >
      {copiedPath ? (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.2 6.4 4.6 8.8 9.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1"/><path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
      )}
    </button>
  );

  const fileActions = (targetPath: string) => (
    <>
      <button
        className="chat-file-viewer-btn"
        onClick={() => openInEditor(targetPath)}
        title="Open in editor"
      >
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      <button className="chat-file-viewer-btn" onClick={handleCloseFile} title="Close file">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
      </button>
    </>
  );

  const isHtml = activePath ? isHtmlFile(activePath) : false;
  const hasFile = activePath && view.kind !== "idle";

  return (
    <>
      <div
        className={`right-panel${open ? " open" : ""}${fullscreen ? " right-panel--fullscreen" : ""}`}
        style={open && !fullscreen ? { width, minWidth: width } : undefined}
      >
        <div className="right-panel-header">
          {fullscreen && (
            <button
              className="right-panel-close"
              onClick={() => setFullscreen(false)}
              title="Exit fullscreen"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4 1v3H1M8 11V8h3M1 8h3v3M11 4H8V1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          <span className="right-panel-title">viewer</span>
          <div className="right-panel-header-actions">
            {/* HTML preview/source toggle */}
            {hasFile && isHtml && view.kind === "file" && (
              <button
                className={`right-panel-header-btn${htmlPreview ? " active" : ""}`}
                onClick={() => setHtmlPreview(!htmlPreview)}
                title={htmlPreview ? "Show source" : "Show preview"}
              >
                {htmlPreview ? (
                  // Code icon
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 3L1 6l3 3M8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  // Eye icon
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" stroke="currentColor" strokeWidth="1.1"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/></svg>
                )}
              </button>
            )}
            {/* Fullscreen toggle */}
            {hasFile && (
              <button
                className="right-panel-header-btn"
                onClick={() => setFullscreen(!fullscreen)}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 1v3H1M8 11V8h3M1 8h3v3M11 4H8V1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            )}
          </div>
        </div>
        <div className="right-panel-content">
          {hasFile && view.kind === "directory" ? (
            <div className="fcv-panel right-panel-file">
              <div className="fcv-head">
                <div className="fcv-meta">
                  <div className="fcv-name-row">
                    <span className="fcv-name">{basename(view.result.path) || "/"}</span>
                    <div className="fcv-name-actions">{copyBtn(view.result.path)}</div>
                  </div>
                </div>
                <div className="fcv-head-side">
                  <span className="fcv-count">{directoryEntries.length} folder{directoryEntries.length === 1 ? "" : "s"}</span>
                  <div className="fcv-actions">{fileActions(view.result.path)}</div>
                </div>
              </div>
              <div className="fcv-body">
                <div className="fcv-directory">
                  <div className="fcv-directory-path">{view.result.path}</div>
                  <div className="fcv-directory-list">
                    {view.result.parent && (
                      <button className="fcv-directory-entry fcv-directory-entry--parent" onClick={() => setActivePath(view.result.parent)}>
                        ..
                      </button>
                    )}
                    {directoryEntries.length === 0 && <div className="fcv-state">No subfolders.</div>}
                    {directoryEntries.map((entry) => (
                      <button key={entry.key} className="fcv-directory-entry" onClick={() => setActivePath(entry.path)}>
                        <span className="fcv-directory-dot" aria-hidden="true" />
                        <span className="fcv-directory-name">{entry.name}</span>
                        <span className="fcv-directory-type">dir</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : hasFile && isHtml && htmlPreview && view.kind === "file" ? (
            <div className="right-panel-file right-panel-canvas">
              <div className="fcv-head">
                <div className="fcv-meta">
                  <div className="fcv-name-row">
                    <span className="fcv-name">{basename(activePath!)}</span>
                    <div className="fcv-name-actions">{copyBtn(activePath!)}</div>
                  </div>
                </div>
                <div className="fcv-head-side">
                  <span className="fcv-count">preview</span>
                  <div className="fcv-actions">{fileActions(activePath!)}</div>
                </div>
              </div>
              <iframe
                className="right-panel-iframe"
                srcDoc={view.content}
                sandbox="allow-scripts allow-same-origin"
                title="HTML Preview"
              />
            </div>
          ) : hasFile ? (
            <div className="right-panel-file">
              <FileContentViewer
                filePath={activePath!}
                content={view.kind === "file" ? view.content : null}
                loading={loading}
                error={view.kind === "error" ? view.message : null}
                nameActions={copyBtn(activePath!)}
                actions={fileActions(activePath!)}
              />
            </div>
          ) : (
            children || <div className="panel-empty">no file open</div>
          )}
        </div>
      </div>
    </>
  );
}
