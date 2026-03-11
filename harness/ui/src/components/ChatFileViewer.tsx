import { useEffect, useMemo, useState } from "react";
import { browsePath, openInEditor, readFileContent, type BrowseResult } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { FloatingWindow } from "./FloatingWindow";

type Props = {
  path: string | null;
  onClose: () => void;
};

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

type ViewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "file"; content: string }
  | { kind: "directory"; result: BrowseResult }
  | { kind: "error"; message: string };

export function ChatFileViewer({ path, onClose }: Props) {
  const [activePath, setActivePath] = useState<string | null>(path);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [copiedPath, setCopiedPath] = useState(false);

  useEffect(() => {
    setActivePath(path);
  }, [path]);

  useEffect(() => {
    if (!activePath) return;
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const dirResult = await browsePath(activePath, { includeHidden: true });
        if (active) {
          setView({ kind: "directory", result: dirResult });
        }
        return;
      } catch {
        try {
          const text = await readFileContent(activePath);
          if (!active) return;
          if (text !== null) {
            setView({ kind: "file", content: text });
            return;
          }
        } catch {
          // fall through to error state below
        }
        if (active) {
          setView({ kind: "error", message: "Could not load this path." });
        }
      }
    })()
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [activePath]);

  useEffect(() => {
    if (!activePath) return;
    setCopiedPath(false);
  }, [activePath]);

  useEffect(() => {
    if (!copiedPath) return;
    const timer = window.setTimeout(() => setCopiedPath(false), 1000);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);

  const directoryEntries = useMemo(() => {
    if (view.kind !== "directory") return [];
    const dirs = view.result.dirs.map((dir) => ({
      key: `dir:${dir}`,
      name: dir,
      path: `${view.result.path}/${dir}`,
      kind: "directory" as const,
    }));
    return dirs;
  }, [view]);

  return (
    <FloatingWindow
      open={!!activePath}
      onClose={onClose}
      storageKey="chat-file-viewer-bounds"
      className="chat-file-viewer-popup"
    >
      {({ onPointerDown }) => (
        view.kind === "directory" ? (
          <div className="fcv-panel">
            <div className="fcv-head fcv-head--draggable" onPointerDown={onPointerDown}>
              <div className="fcv-meta">
                <div className="fcv-name-row">
                  <span className="fcv-name">{basename(view.result.path) || "/"}</span>
                  <div className="fcv-name-actions">
                    <button
                      className={`chat-file-viewer-btn chat-file-viewer-btn--inline${copiedPath ? " is-copied" : ""}`}
                      onClick={() => {
                        navigator.clipboard.writeText(view.result.path).then(() => setCopiedPath(true)).catch(() => {});
                      }}
                      title={copiedPath ? "Copied full path" : "Copy full path"}
                      aria-label={copiedPath ? "Copied full path" : "Copy full path"}
                    >
                      {copiedPath ? (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M2.2 6.4 4.6 8.8 9.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
                          <path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>
              <div className="fcv-head-side">
                <span className="fcv-count">
                  {directoryEntries.length} folder{directoryEntries.length === 1 ? "" : "s"}
                </span>
                <div className="fcv-actions">
                  <button
                    className="chat-file-viewer-btn"
                    onClick={() => openInEditor(view.result.path)}
                    title="Open in editor"
                    aria-label="Open in editor"
                  >
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button className="chat-file-viewer-btn" onClick={onClose} title="Close" aria-label="Close">
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                      <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
            <div className="fcv-body">
              <div className="fcv-directory">
                <div className="fcv-directory-path">{view.result.path}</div>
                <div className="fcv-directory-list">
                  {view.result.parent && (
                    <button
                      className="fcv-directory-entry fcv-directory-entry--parent"
                      onClick={() => setActivePath(view.result.parent)}
                    >
                      ..
                    </button>
                  )}
                  {directoryEntries.length === 0 && (
                    <div className="fcv-state">No subfolders in this directory.</div>
                  )}
                  {directoryEntries.map((entry) => (
                    <button
                      key={entry.key}
                      className="fcv-directory-entry"
                      onClick={() => setActivePath(entry.path)}
                    >
                      <span className="fcv-directory-dot" aria-hidden="true" />
                      <span className="fcv-directory-name">{entry.name}</span>
                      <span className="fcv-directory-type">dir</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <FileContentViewer
            filePath={activePath!}
            content={view.kind === "file" ? view.content : null}
            loading={loading}
            error={view.kind === "error" ? view.message : null}
            onHeaderPointerDown={onPointerDown}
            nameActions={
              <button
                className={`chat-file-viewer-btn chat-file-viewer-btn--inline${copiedPath ? " is-copied" : ""}`}
                onClick={() => {
                  navigator.clipboard.writeText(activePath!).then(() => setCopiedPath(true)).catch(() => {});
                }}
                title={copiedPath ? "Copied full path" : "Copy full file path"}
                aria-label={copiedPath ? "Copied full file path" : "Copy full file path"}
              >
                {copiedPath ? (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.2 6.4 4.6 8.8 9.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
                    <path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                  </svg>
                )}
              </button>
            }
            actions={
              <>
                <button
                  className="chat-file-viewer-btn"
                  onClick={() => openInEditor(activePath!)}
                  title="Open in editor"
                  aria-label="Open in editor"
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <button className="chat-file-viewer-btn" onClick={onClose} title="Close" aria-label="Close">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </>
            }
          />
        )
      )}
    </FloatingWindow>
  );
}
