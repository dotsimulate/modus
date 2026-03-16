import { useState, useEffect, useMemo, type ReactNode } from "react";
import { useFileViewer } from "../providers/FileViewerProvider";
import { useProfiles } from "../providers/ProfileProvider";
import { browsePath, openInEditor, readFileContent, type BrowseResult, type MoveWidgetInfo } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { FileBrowser } from "./FileBrowser";
import { MoveWidget } from "./MoveWidget";

type Props = {
  open: boolean;
  width: number;
  onOpen: () => void;
  onClose: () => void;
  children?: ReactNode;
  moveWidgets?: Array<{
    widget: MoveWidgetInfo;
    apiToken: string;
    instanceId: string;
    sessionId: string;
  }> | null;
  initialBrowserPath?: string | null;
  onBrowserPathChange?: (path: string) => void;
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

/** Which tab is showing: the project browser, a file, or a move widget */
type ActiveView = "browser" | "move-widget" | string;

export function RightPanel({ open, width, onOpen, onClose, children, moveWidgets, initialBrowserPath, onBrowserPathChange }: Props) {
  const { tabs, activePath, closeFile, setActive, pinFile, unpinFile, openFile } = useFileViewer();
  const { activeCwd } = useProfiles();

  const [activeView, setActiveView] = useState<ActiveView>("browser");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [copiedPath, setCopiedPath] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  // When FileViewerProvider's activePath changes (e.g. agent opens a file), switch to it
  useEffect(() => {
    if (activePath) {
      setActiveView(activePath);
      onOpen();
    }
  }, [activePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to a widget tab when a new widget with autoOpen appears
  useEffect(() => {
    const latest = moveWidgets?.findLast(w => w.widget.autoOpen);
    if (latest) {
      setActiveView(`widget:${latest.instanceId}`);
      if (!open) onOpen();
    }
  }, [moveWidgets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync activeView → FileViewerProvider active
  useEffect(() => {
    if (activeView !== "browser" && !activeView.startsWith("widget:") && activeView !== activePath) {
      setActive(activeView);
    }
  }, [activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewingFile = activeView !== "browser" && !activeView.startsWith("widget:") ? activeView : null;

  // Load content for the file being viewed
  useEffect(() => {
    if (!viewingFile) { setView({ kind: "idle" }); return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const dirResult = await browsePath(viewingFile, { includeHidden: true });
        if (active) setView({ kind: "directory", result: dirResult });
        return;
      } catch {
        try {
          const text = await readFileContent(viewingFile);
          if (!active) return;
          if (text !== null) { setView({ kind: "file", content: text }); return; }
        } catch { /* fall through */ }
        if (active) setView({ kind: "error", message: "Could not load this path." });
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [viewingFile]);

  // Reset preview mode when switching files
  useEffect(() => {
    if (viewingFile) {
      setCopiedPath(false);
      setHtmlPreview(true);
    }
  }, [viewingFile]);

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

  const handleCloseFile = () => {
    setFullscreen(false);
    if (viewingFile) closeFile(viewingFile);
    setActiveView("browser");
  };

  const handleCloseTab = (path: string) => {
    closeFile(path);
    if (activeView === path) setActiveView("browser");
  };

  const handleFileSelect = (path: string) => {
    openFile(path);
    setActiveView(path);
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

  const isHtml = viewingFile ? isHtmlFile(viewingFile) : false;
  const showFileContent = viewingFile && view.kind !== "idle";
  const showBrowser = activeView === "browser";

  return (
    <>
      <div
        className={`right-panel${open ? " open" : ""}${fullscreen ? " right-panel--fullscreen" : ""}`}
        style={open && !fullscreen ? { width, minWidth: width } : undefined}
      >
        {/* Tab bar — always visible: browser tab + file tabs */}
        <div className="rp-tabs">
          <div className={`rp-tab${showBrowser ? " rp-tab--active" : ""}`}>
            <button
              className="rp-tab-label"
              onClick={() => setActiveView("browser")}
              title="Project files"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
              </svg>
              files
            </button>
          </div>
          {moveWidgets?.map((w) => (
            <div key={w.instanceId} className={`rp-tab${activeView === `widget:${w.instanceId}` ? " rp-tab--active" : ""}`}>
              <button
                className="rp-tab-label"
                onClick={() => setActiveView(`widget:${w.instanceId}`)}
                title={w.widget.label}
              >
                {w.widget.label}
              </button>
            </div>
          ))}
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`rp-tab${tab.path === activeView ? " rp-tab--active" : ""}${tab.pinned ? " rp-tab--pinned" : ""}`}
            >
              <button
                className="rp-tab-label"
                onClick={() => setActiveView(tab.path)}
                title={tab.path}
              >
                {tab.pinned && (
                  <svg className="rp-tab-pin" width="7" height="7" viewBox="0 0 12 12" fill="none">
                    <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="currentColor"/>
                    <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                )}
                {basename(tab.path)}
              </button>
              <button
                className="rp-tab-close"
                onClick={(e) => { e.stopPropagation(); openInEditor(tab.path); }}
                title="Open in editor"
              >
                <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                  <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                className="rp-tab-close"
                onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.path); }}
                title="Close tab"
              >
                <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
          <div className="rp-tabs-actions">
            {viewingFile && (
              <button
                className={`right-panel-header-btn${tabs.find((t) => t.path === viewingFile)?.pinned ? " active" : ""}`}
                onClick={() => {
                  const tab = tabs.find((t) => t.path === viewingFile);
                  if (tab?.pinned) unpinFile(viewingFile);
                  else pinFile(viewingFile);
                }}
                title={tabs.find((t) => t.path === viewingFile)?.pinned ? "Unpin file" : "Pin file"}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill={tabs.find((t) => t.path === viewingFile)?.pinned ? "currentColor" : "none"}/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {showFileContent && isHtml && view.kind === "file" && (
              <button
                className={`right-panel-header-btn${htmlPreview ? " active" : ""}`}
                onClick={() => setHtmlPreview(!htmlPreview)}
                title={htmlPreview ? "Show source" : "Show preview"}
              >
                {htmlPreview ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 3L1 6l3 3M8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" stroke="currentColor" strokeWidth="1.1"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/></svg>
                )}
              </button>
            )}
            {showFileContent && (
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
          {activeView.startsWith("widget:") && moveWidgets ? (() => {
            const w = moveWidgets.find(w => `widget:${w.instanceId}` === activeView);
            return w ? <MoveWidget widget={w.widget} apiToken={w.apiToken} instanceId={w.instanceId} sessionId={w.sessionId} /> : null;
          })() : showBrowser ? (
            <FileBrowser
              rootPath={activeCwd ?? null}
              initialPath={initialBrowserPath}
              onFileSelect={handleFileSelect}
              onPathChange={onBrowserPathChange}
            />
          ) : showFileContent && view.kind === "directory" ? (
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
                      <button className="fcv-directory-entry fcv-directory-entry--parent" onClick={() => setActiveView(view.result.parent!)}>
                        ..
                      </button>
                    )}
                    {directoryEntries.length === 0 && <div className="fcv-state">No subfolders.</div>}
                    {directoryEntries.map((entry) => (
                      <button key={entry.key} className="fcv-directory-entry" onClick={() => setActiveView(entry.path)}>
                        <span className="fcv-directory-dot" aria-hidden="true" />
                        <span className="fcv-directory-name">{entry.name}</span>
                        <span className="fcv-directory-type">dir</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : showFileContent && isHtml && htmlPreview && view.kind === "file" ? (
            <div className="right-panel-file right-panel-canvas">
              <div className="fcv-head">
                <div className="fcv-meta">
                  <div className="fcv-name-row">
                    <span className="fcv-name">{basename(viewingFile!)}</span>
                    <div className="fcv-name-actions">{copyBtn(viewingFile!)}</div>
                  </div>
                </div>
                <div className="fcv-head-side">
                  <span className="fcv-count">preview</span>
                  <div className="fcv-actions">{fileActions(viewingFile!)}</div>
                </div>
              </div>
              <iframe
                className="right-panel-iframe"
                srcDoc={view.content}
                sandbox="allow-scripts allow-same-origin"
                title="HTML Preview"
              />
            </div>
          ) : showFileContent ? (
            <div className="right-panel-file">
              <FileContentViewer
                filePath={viewingFile!}
                content={view.kind === "file" ? view.content : null}
                loading={loading}
                error={view.kind === "error" ? view.message : null}
                nameActions={copyBtn(viewingFile!)}
                actions={fileActions(viewingFile!)}
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
