import { useState, useEffect, useRef, useCallback, type ReactNode, type WheelEvent } from "react";
import { useFileViewer } from "../providers/FileViewerProvider";
import { usePinboard } from "../providers/PinboardProvider";
import { useProfiles } from "../providers/ProfileProvider";
import { browsePath, readFileContent, openInEditor, type BrowseResult, type MoveWidgetInfo } from "../api";
import type { Message } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { FileBrowser } from "./FileBrowser";
import { MoveWidget, evictWidgetModule } from "./MoveWidget";
import { CodeMirrorEditor, type CodeMirrorContextInfo } from "./CodeMirrorEditor";
import { CopyButton } from "./CopyButton";
import { DirectoryViewer } from "./DirectoryViewer";
import { HtmlPreview } from "./HtmlPreview";
import { PinboardView } from "./PinboardView";
import { SessionEditsView } from "./SessionEditsView";
import { AgentActivityView } from "./AgentActivityView";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

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
    mountedOnAttach?: boolean;
  }> | null;
  initialBrowserPath?: string | null;
  onBrowserPathChange?: (path: string) => void;
  messages?: Message[];
  requestView?: string | null;
  onRequestViewHandled?: () => void;
  /** Called when user closes a widget tab (for detach cleanup) */
  onWidgetClose?: (apiToken: string, moveName: string) => void;
  /** Called when user wants to send a code snippet to the chat input */
  onSendToAgent?: (text: string) => void;
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

/** Which tab is showing: the project browser, pinboard, a file, or a move widget */
type ActiveView = "browser" | "pins" | "move-widget" | string;

export function RightPanel({ open, width, onOpen, onClose, children, moveWidgets, initialBrowserPath, onBrowserPathChange, messages, requestView, onRequestViewHandled, onWidgetClose, onSendToAgent }: Props) {
  const {
    tabs, activePath, closeFile, setActive, openFile,
    setEditing, markDirty, saveFile, saving, saveError,
  } = useFileViewer();
  const { groups, pinToActive, pinToGroup, unpinFromActive, isFilePinned, activeGroup } = usePinboard();
  const { activeCwd } = useProfiles();

  const tabsRef = useRef<HTMLDivElement>(null);
  const [activeView, setActiveView] = useState<ActiveView>("browser");
  const NON_FILE_VIEWS = new Set(["browser", "pins", "session-edits", "activity"]);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [htmlPreview, setHtmlPreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenBrowser, setFullscreenBrowser] = useState(false);
  // Reload counter per widget — incrementing forces a remount by changing the key
  const [widgetReloadKeys, setWidgetReloadKeys] = useState<Record<string, number>>({});

  // Handle imperative view requests (e.g. open session-edits from chat)
  useEffect(() => {
    if (!requestView) return;
    setActiveView(requestView);
    onOpen();
    onRequestViewHandled?.();
  }, [requestView]); // eslint-disable-line react-hooks/exhaustive-deps

  // When FileViewerProvider's activePath changes (e.g. agent opens a file), switch to it
  useEffect(() => {
    if (activePath) {
      setActiveView(activePath);
      onOpen();
    }
  }, [activePath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to a widget tab when a genuinely new widget with autoOpen appears
  const prevWidgetIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(moveWidgets?.map(w => w.instanceId) ?? []);
    const newAutoOpen = moveWidgets?.findLast(
      w => w.widget.autoOpen && !prevWidgetIds.current.has(w.instanceId),
    );
    prevWidgetIds.current = currentIds;
    if (newAutoOpen) {
      setActiveView(`widget:${newAutoOpen.instanceId}`);
      if (!open) onOpen();
    }
  }, [moveWidgets]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync activeView → FileViewerProvider active
  useEffect(() => {
    if (!NON_FILE_VIEWS.has(activeView) && !activeView.startsWith("widget:") && activeView !== activePath) {
      setActive(activeView);
    }
  }, [activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  const viewingFile = !NON_FILE_VIEWS.has(activeView) && !activeView.startsWith("widget:") ? activeView : null;
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

  // ── Context menus ──

  const editorCtxMenu = useContextMenu();
  const tabCtxMenu = useContextMenu();

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

  /** Collapses pin actions into a submenu when there are multiple groups */
  const buildPinSubmenu = useCallback((path: string): ContextMenuItem => {
    const items = buildPinItems(path);
    if (items.length === 1) return items[0];
    return { kind: "submenu", icon: pinIcon, label: "Pin to pinboard…", items };
  }, [buildPinItems, pinIcon]);

  const handleEditorContextMenu = useCallback((e: React.MouseEvent, info: CodeMirrorContextInfo) => {
    const items: ContextMenuItem[] = [];
    if (info.selection) {
      items.push({
        kind: "action",
        label: "Copy selection",
        onClick: () => navigator.clipboard.writeText(info.selection),
      });
      items.push({
        kind: "action",
        label: "Copy as code block",
        onClick: () => navigator.clipboard.writeText(`\`\`\`\n${info.selection}\n\`\`\``),
      });
    }
    items.push({
      kind: "action",
      label: "Copy reference",
      onClick: () => navigator.clipboard.writeText(`${info.path}:${info.line}`),
    });
    items.push({
      kind: "action",
      label: "Copy file path",
      onClick: () => navigator.clipboard.writeText(info.path),
    });
    items.push({
      kind: "action",
      label: "Open in external editor",
      onClick: () => openInEditor(info.path, info.line),
    });
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(buildPinSubmenu(info.path));
    }
    if (onSendToAgent) {
      items.push({ kind: "separator" });
      const snippet = info.selection
        ? `${info.path}:${info.line}\n\`\`\`\n${info.selection}\n\`\`\``
        : `${info.path}:${info.line}`;
      items.push({
        kind: "action",
        label: info.selection ? "Send selection to agent" : "Send reference to agent",
        onClick: () => onSendToAgent(snippet),
      });
    }
    editorCtxMenu.open(e, items);
  }, [buildPinSubmenu, groups.length, onSendToAgent, editorCtxMenu]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabPath: string) => {
    const items: ContextMenuItem[] = [
      { kind: "action", label: "Close", onClick: () => handleCloseTab(tabPath) },
      {
        kind: "action",
        label: "Close others",
        disabled: tabs.length <= 1,
        onClick: () => tabs.filter(t => t.path !== tabPath).forEach(t => closeFile(t.path)),
      },
      {
        kind: "action",
        label: "Close all",
        disabled: tabs.length === 0,
        onClick: () => { tabs.forEach(t => closeFile(t.path)); setActiveView("browser"); },
      },
      { kind: "separator" },
      { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(tabPath) },
      { kind: "action", label: "Open in external editor", onClick: () => openInEditor(tabPath) },
    ];
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(buildPinSubmenu(tabPath));
    }
    tabCtxMenu.open(e, items);
  }, [tabs, closeFile, handleCloseTab, buildPinSubmenu, groups.length, tabCtxMenu]);

  // ── Derived state ──

  const isHtml = viewingFile ? isHtmlFile(viewingFile) : false;
  const showFileContent = viewingFile && view.kind !== "idle";
  const showBrowser = activeView === "browser";
  const showPins = activeView === "pins";

  // ── Content renderer — flat early-return instead of nested ternaries ──

  function renderContent() {
    // Session edits
    if (activeView === "session-edits") {
      return <SessionEditsView messages={messages ?? []} />;
    }

    // Agent activity
    if (activeView === "activity") {
      return <AgentActivityView messages={messages ?? []} />;
    }

    // Move widget — for non-instance-cached widgets, render inline (instance-cached render below)
    if (activeView.startsWith("widget:") && moveWidgets) {
      const w = moveWidgets.find(w => `widget:${w.instanceId}` === activeView);
      if (w && (w.widget.cache ?? "instance") !== "instance") {
        return <MoveWidget key={`${w.instanceId}-${widgetReloadKeys[w.instanceId] ?? 0}`} widget={w.widget} apiToken={w.apiToken} instanceId={w.instanceId} sessionId={w.sessionId} mountedOnAttach={w.mountedOnAttach} />;
      }
      // instance-cached widgets are rendered persistently below — return null so the persistent layer shows
      if (w) return null;
    }

    // Pinboard
    if (showPins) {
      return (
        <PinboardView
          onOpenFile={(path) => {
            openFile(path);
            setActiveView(path);
          }}
        />
      );
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
              onEditorContextMenu={handleEditorContextMenu}
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
            onEditorContextMenu={handleEditorContextMenu}
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
        <div
          className="rp-tabs"
          ref={tabsRef}
          onWheel={(e: WheelEvent<HTMLDivElement>) => {
            if (!tabsRef.current) return;
            e.preventDefault();
            tabsRef.current.scrollLeft += e.deltaY + e.deltaX;
          }}
        >
          <div className={`rp-tab rp-tab--icon-only${showBrowser ? " rp-tab--active" : ""}`}>
            <button
              className="rp-tab-label"
              onClick={() => setActiveView("browser")}
              title="Project files"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
              </svg>
            </button>
          </div>
          <div className={`rp-tab rp-tab--icon-only${showPins ? " rp-tab--active" : ""}`}>
            <button
              className="rp-tab-label"
              onClick={() => setActiveView("pins")}
              title="Pinned files"
            >
              <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill={showPins ? "currentColor" : "none"}/>
                <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          <div className={`rp-tab rp-tab--icon-only${activeView === "activity" ? " rp-tab--active" : ""}`}>
            <button
              className="rp-tab-label"
              onClick={() => setActiveView("activity")}
              title="Agent activity"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M1 6h2l1.5-3 2 6L8.5 3 10 6h1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div className={`rp-tab rp-tab--icon-only${activeView === "session-edits" ? " rp-tab--active" : ""}`}>
            <button
              className="rp-tab-label"
              onClick={() => setActiveView("session-edits")}
              title="Files edited this session"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <rect x="1" y="1" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
                <rect x="1" y="5.5" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
              </svg>
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
              <button
                className="rp-tab-close rp-tab-refresh"
                onClick={(e) => {
                  e.stopPropagation();
                  evictWidgetModule(w.widget.moduleUrl);
                  setWidgetReloadKeys(prev => ({ ...prev, [w.instanceId]: (prev[w.instanceId] ?? 0) + 1 }));
                }}
                title="Reload widget"
              >
                <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                  <path d="M10 2v3H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M9.5 7.5a4 4 0 1 1-.9-4.1L10 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                </svg>
              </button>
              <button
                className="rp-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  onWidgetClose?.(w.apiToken, w.widget.moveName);
                  if (activeView === `widget:${w.instanceId}`) setActiveView("browser");
                }}
                title="Close widget"
              >
                <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={`rp-tab${tab.path === activeView ? " rp-tab--active" : ""}${isFilePinned(tab.path) ? " rp-tab--pinned" : ""}${tab.dirty ? " rp-tab--dirty" : ""}`}
              onContextMenu={(e) => handleTabContextMenu(e, tab.path)}
            >
              <button
                className="rp-tab-label"
                onClick={() => setActiveView(tab.path)}
                title={tab.path}
              >
                {tab.dirty && <span className="rp-tab-dot" />}
                {isFilePinned(tab.path) && (
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
            {/* Pin to cross-session pinboard */}
            {viewingFile && (
              <button
                className={`right-panel-header-btn rp-pin-btn${isFilePinned(viewingFile) ? " active" : ""}`}
                onClick={() => {
                  if (isFilePinned(viewingFile)) unpinFromActive(viewingFile);
                  else pinToActive(viewingFile);
                }}
                title={isFilePinned(viewingFile) ? `Unpin from "${activeGroup?.name}"` : `Pin to "${activeGroup?.name}"`}
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill={isFilePinned(viewingFile) ? "currentColor" : "none"}/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
                </svg>
                {activeGroup && <span className="rp-pin-group">{activeGroup.name}</span>}
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
            {/* Persistent widget layer — instance-cached widgets stay mounted, hidden when not active */}
            {moveWidgets?.filter(w => (w.widget.cache ?? "instance") === "instance").map(w => (
              <div
                key={`${w.instanceId}-${widgetReloadKeys[w.instanceId] ?? 0}`}
                style={{ display: activeView === `widget:${w.instanceId}` ? "contents" : "none" }}
              >
                <MoveWidget widget={w.widget} apiToken={w.apiToken} instanceId={w.instanceId} sessionId={w.sessionId} mountedOnAttach={w.mountedOnAttach} />
              </div>
            ))}
          </div>
        </div>
      </div>
      {editorCtxMenu.portal}
      {tabCtxMenu.portal}
    </>
  );
}
