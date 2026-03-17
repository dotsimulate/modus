import { useState, useEffect, type ReactNode } from "react";
import { useFileViewer } from "../providers/FileViewerProvider";
import { useProfiles } from "../providers/ProfileProvider";
import { browsePath, readFileContent, type BrowseResult, type MoveWidgetInfo } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { FileBrowser } from "./FileBrowser";
import { MoveWidget } from "./MoveWidget";
import { CodeMirrorEditor } from "./CodeMirrorEditor";
import { CopyButton } from "./CopyButton";
import { DirectoryViewer } from "./DirectoryViewer";
import { HtmlPreview } from "./HtmlPreview";

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

const IMAGE_EXTS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".avif", ".tiff", ".tif", ".svg"]);
function isImageFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && IMAGE_EXTS.has(path.slice(dot).toLowerCase());
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
  const {
    tabs, activePath, closeFile, setActive, pinFile, unpinFile, openFile,
    setEditing, markDirty, saveFile, saving, saveError,
  } = useFileViewer();
  const { activeCwd } = useProfiles();

  const [activeView, setActiveView] = useState<ActiveView>("browser");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [htmlPreview, setHtmlPreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenBrowser, setFullscreenBrowser] = useState(false);

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
  const activeTab = viewingFile ? tabs.find((t) => t.path === viewingFile) : null;
  const isEditMode = activeTab?.editing ?? false;

  // Load content for the file being viewed (only in view mode — edit mode loads via provider)
  useEffect(() => {
    if (!viewingFile || isEditMode) { if (!viewingFile) setView({ kind: "idle" }); return; }
    // Images are served via /api/file-serve — no need to load text content
    if (isImageFile(viewingFile)) { setView({ kind: "file", content: "" }); setLoading(false); return; }
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
  }, [viewingFile, isEditMode]);

  // Reset preview mode when switching files
  useEffect(() => {
    if (viewingFile) setHtmlPreview(true);
  }, [viewingFile]);

  // ── Handlers ──

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

  const handleToggleEdit = () => {
    if (!viewingFile) return;
    setEditing(viewingFile, !isEditMode);
  };

  const handleSave = async (content: string) => {
    if (!viewingFile) return;
    await saveFile(viewingFile, content);
  };

  const handleDirty = () => {
    if (viewingFile) markDirty(viewingFile);
  };

  // ── Shared action slots passed to content components ──

  const copyPathBtn = (targetPath: string) => (
    <CopyButton value={targetPath} size="inline" title="Copy path" />
  );

  const closeBtn = (
    <button className="chat-file-viewer-btn" onClick={handleCloseFile} title="Close file">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
    </button>
  );

  const fileActions = (targetPath: string) => (
    <>
      <CopyButton
        getValue={async () => {
          if (view.kind === "file") return view.content;
          return readFileContent(targetPath);
        }}
        title="Copy file contents"
      />
      {closeBtn}
    </>
  );

  // ── Derived state ──

  const isHtml = viewingFile ? isHtmlFile(viewingFile) : false;
  const showFileContent = viewingFile && view.kind !== "idle";
  const showBrowser = activeView === "browser";

  // ── Content renderer — flat early-return instead of nested ternaries ──

  function renderContent() {
    // Move widget
    if (activeView.startsWith("widget:") && moveWidgets) {
      const w = moveWidgets.find(w => `widget:${w.instanceId}` === activeView);
      return w ? <MoveWidget widget={w.widget} apiToken={w.apiToken} instanceId={w.instanceId} sessionId={w.sessionId} /> : null;
    }

    // Edit mode
    if (isEditMode && viewingFile) {
      if (activeTab?.content !== null) {
        return (
          <div className="right-panel-editor">
            <CodeMirrorEditor
              key={viewingFile}
              content={activeTab!.content!}
              path={viewingFile}
              onSave={handleSave}
              onDirty={handleDirty}
            />
          </div>
        );
      }
      return <div className="panel-empty">loading...</div>;
    }

    // File browser
    if (showBrowser) {
      return (
        <FileBrowser
          rootPath={activeCwd ?? null}
          initialPath={initialBrowserPath}
          onFileSelect={handleFileSelect}
          onPathChange={onBrowserPathChange}
        />
      );
    }

    // Directory listing
    if (showFileContent && view.kind === "directory") {
      return (
        <DirectoryViewer
          path={view.result.path}
          dirs={view.result.dirs}
          parent={view.result.parent ?? null}
          onNavigate={setActiveView}
          nameActions={copyPathBtn(view.result.path)}
          actions={fileActions(view.result.path)}
        />
      );
    }

    // Image viewer
    if (!isEditMode && viewingFile && isImageFile(viewingFile)) {
      const src = `/api/file-serve?path=${encodeURIComponent(viewingFile)}`;
      return (
        <div className="right-panel-image-viewer">
          <div className="right-panel-image-header">
            <span className="right-panel-image-name">{basename(viewingFile)}</span>
            <div className="right-panel-image-actions">
              {copyPathBtn(viewingFile)}
              {closeBtn}
            </div>
          </div>
          <div className="right-panel-image-body">
            <img src={src} alt={basename(viewingFile)} className="right-panel-image" />
          </div>
        </div>
      );
    }

    // HTML preview
    if (!isEditMode && showFileContent && isHtml && htmlPreview && view.kind === "file") {
      return (
        <HtmlPreview
          filePath={viewingFile!}
          content={view.content}
          nameActions={copyPathBtn(viewingFile!)}
          actions={fileActions(viewingFile!)}
        />
      );
    }

    // File viewer (code, markdown, loading, error)
    if (showFileContent) {
      return (
        <div className="right-panel-file">
          <FileContentViewer
            filePath={viewingFile!}
            content={view.kind === "file" ? view.content : null}
            loading={loading}
            error={view.kind === "error" ? view.message : null}
            nameActions={copyPathBtn(viewingFile!)}
            actions={fileActions(viewingFile!)}
          />
        </div>
      );
    }

    // Fallback
    return children || <div className="panel-empty">no file open</div>;
  }

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
              className={`rp-tab${tab.path === activeView ? " rp-tab--active" : ""}${tab.pinned ? " rp-tab--pinned" : ""}${tab.dirty ? " rp-tab--dirty" : ""}`}
            >
              <button
                className="rp-tab-label"
                onClick={() => setActiveView(tab.path)}
                title={tab.path}
              >
                {tab.dirty && <span className="rp-tab-dot" />}
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
            {/* Edit/view toggle */}
            {viewingFile && view.kind !== "directory" && !isImageFile(viewingFile) && (
              <button
                className={`right-panel-header-btn${isEditMode ? " active" : ""}`}
                onClick={handleToggleEdit}
                title={isEditMode ? "Switch to view" : "Edit file"}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
            {/* Pin */}
            {viewingFile && (
              <button
                className={`right-panel-header-btn${activeTab?.pinned ? " active" : ""}`}
                onClick={() => {
                  if (activeTab?.pinned) unpinFile(viewingFile);
                  else pinFile(viewingFile);
                }}
                title={activeTab?.pinned ? "Unpin file" : "Pin file"}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill={activeTab?.pinned ? "currentColor" : "none"}/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {/* HTML preview toggle */}
            {!isEditMode && showFileContent && isHtml && view.kind === "file" && (
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
            {/* File browser toggle (fullscreen only) */}
            {fullscreen && (
              <button
                className={`right-panel-header-btn${fullscreenBrowser ? " active" : ""}`}
                onClick={() => setFullscreenBrowser((b) => !b)}
                title={fullscreenBrowser ? "Hide file browser" : "Show file browser"}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.1" fill="none"/>
                </svg>
              </button>
            )}
            {/* Fullscreen */}
            {(showFileContent || isEditMode) && (
              <button
                className="right-panel-header-btn"
                onClick={() => { setFullscreen(!fullscreen); if (fullscreen) setFullscreenBrowser(false); }}
                title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {fullscreen ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 1v3H1M8 11V8h3M1 8h3v3M11 4H8V1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                )}
              </button>
            )}
            {/* Save status */}
            {saving && <span className="rp-status rp-status--saving">saving...</span>}
            {saveError && <span className="rp-status rp-status--error">{saveError}</span>}
          </div>
        </div>

        <div className={`right-panel-body${fullscreen && fullscreenBrowser ? " right-panel-body--split" : ""}`}>
          {fullscreen && fullscreenBrowser && (
            <div className="right-panel-fs-browser">
              <FileBrowser
                rootPath={activeCwd ?? null}
                initialPath={initialBrowserPath}
                onFileSelect={handleFileSelect}
                onPathChange={onBrowserPathChange}
              />
            </div>
          )}
          <div className={`right-panel-content${isEditMode ? " right-panel-content--editing" : ""}`}>
            {renderContent()}
          </div>
        </div>
      </div>
    </>
  );
}
