import { useState, useEffect, useCallback, useRef } from "react";
import { useFileViewer } from "../providers/FileViewerContext";
import { usePinboard } from "../providers/PinboardContext";
import { useProfiles } from "../providers/ProfileContext";
import { modus } from "../modusClient";
import type { BrowseResult } from "../../../sdk/index";
import { setFsWatchRoot } from "../modusClient";
import { FileContentViewer } from "./FileContentViewer";
import { FileBrowser } from "./FileBrowser";
import { CodeMirrorEditor, type CodeMirrorContextInfo } from "./CodeMirrorEditor";
import { CopyButton } from "./CopyButton";
import { DirectoryViewer } from "./DirectoryViewer";
import { HtmlPreview } from "./HtmlPreview";
import { PinboardView } from "./PinboardView";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

type Props = {
  active?: boolean;
  initialBrowserPath?: string | null;
  onBrowserPathChange?: (path: string) => void;
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

type ActiveView = "browser" | "pins" | string;

export function CodeWorkspacePanel({ active = true, initialBrowserPath, onBrowserPathChange, onSendToAgent }: Props) {
  const {
    tabs, closeFile, openFile,
    setEditing, markDirty, saveFile, saving, saveError,
    contentVersion,
  } = useFileViewer();
  const { groups, pinToActive, pinToGroup, unpinFromActive, isFilePinned, activeGroup } = usePinboard();
  const { activeCwd } = useProfiles();

  useEffect(() => {
    setFsWatchRoot(activeCwd ?? null);
  }, [activeCwd]);

  const [activeView, setActiveView] = useState<ActiveView>("browser");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [htmlPreview, setHtmlPreview] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenBrowser, setFullscreenBrowser] = useState(false);
  const prevTabsRef = useRef(tabs);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prevTabs = prevTabsRef.current;
    prevTabsRef.current = tabs;

    if (activeView !== "browser" && activeView !== "pins" && !tabs.some((tab) => tab.path === activeView)) {
      setActiveView("browser");
      return;
    }

    if (!active || activeView !== "browser") return;
    const newlyOpened = tabs.find((tab) => !prevTabs.some((prevTab) => prevTab.path === tab.path));
    if (newlyOpened) {
      setActiveView(newlyOpened.path);
    }
  }, [active, activeView, tabs]);

  const viewingFile = activeView !== "browser" && activeView !== "pins" ? activeView : null;
  const activeTab = viewingFile ? tabs.find((t) => t.path === viewingFile) : null;
  const isEditMode = activeTab?.editing ?? false;

  useEffect(() => {
    if (!viewingFile || isEditMode) { if (!viewingFile) setView({ kind: "idle" }); return; }
    if (isImageFile(viewingFile)) { setView({ kind: "file", content: "" }); setLoading(false); return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });

    (async () => {
      try {
        const dirResult = await modus.browse(viewingFile, { includeHidden: true });
        if (active) setView({ kind: "directory", result: dirResult });
        return;
      } catch {
        try {
          const text = await modus.readFile(viewingFile);
          if (!active) return;
          if (text !== null) { setView({ kind: "file", content: text }); return; }
        } catch {}
        if (active) setView({ kind: "error", message: "Could not load this path." });
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [viewingFile, isEditMode, contentVersion]);

  useEffect(() => {
    if (viewingFile) setHtmlPreview(true);
  }, [viewingFile]);

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
          return modus.readFile(targetPath);
        }}
        title="Copy file contents"
      />
      {closeBtn}
    </>
  );

  const editorCtxMenu = useContextMenu();
  const tabCtxMenu = useContextMenu();
  const markdownCtxMenu = useContextMenu();

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

  const handleEditorContextMenu = useCallback((e: React.MouseEvent, info: CodeMirrorContextInfo) => {
    const items: ContextMenuItem[] = [];
    if (info.selection) {
      items.push({ kind: "action", label: "Copy selection", onClick: () => navigator.clipboard.writeText(info.selection) });
      items.push({ kind: "action", label: "Copy as code block", onClick: () => navigator.clipboard.writeText(`\`\`\`\n${info.selection}\n\`\`\``) });
    }
    items.push({ kind: "action", label: "Copy reference", onClick: () => navigator.clipboard.writeText(`${info.path}:${info.line}`) });
    items.push({ kind: "action", label: "Copy file path", onClick: () => navigator.clipboard.writeText(info.path) });
    items.push({ kind: "action", label: "Open in external editor", onClick: () => modus.openInEditor(info.path, info.line) });
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(...buildPinItems(info.path));
    }
    if (onSendToAgent) {
      items.push({ kind: "separator" });
      const snippet = info.selection ? `${info.path}:${info.line}\n\`\`\`\n${info.selection}\n\`\`\`` : `${info.path}:${info.line}`;
      items.push({ kind: "action", label: info.selection ? "Send selection to agent" : "Send reference to agent", onClick: () => onSendToAgent(snippet) });
    }
    editorCtxMenu.open(e, items);
  }, [buildPinItems, editorCtxMenu, groups.length, onSendToAgent]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabPath: string) => {
    const items: ContextMenuItem[] = [
      { kind: "action", label: "Close", onClick: () => handleCloseTab(tabPath) },
      { kind: "action", label: "Close others", disabled: tabs.length <= 1, onClick: () => tabs.filter(t => t.path !== tabPath).forEach(t => closeFile(t.path)) },
      { kind: "action", label: "Close all", disabled: tabs.length === 0, onClick: () => { tabs.forEach(t => closeFile(t.path)); setActiveView("browser"); } },
      { kind: "separator" },
      { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(tabPath) },
      { kind: "action", label: "Open in external editor", onClick: () => modus.openInEditor(tabPath) },
    ];
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(...buildPinItems(tabPath));
    }
    tabCtxMenu.open(e, items);
  }, [buildPinItems, closeFile, groups.length, tabCtxMenu, tabs]);

  const handleMarkdownContextMenu = useCallback((e: React.MouseEvent) => {
    if (!viewingFile) return;
    const items: ContextMenuItem[] = [];
    const sel = window.getSelection()?.toString() ?? "";
    if (sel) {
      items.push({ kind: "action", label: "Copy selection", onClick: () => navigator.clipboard.writeText(sel) });
      items.push({ kind: "action", label: "Copy as code block", onClick: () => navigator.clipboard.writeText(`\`\`\`\n${sel}\n\`\`\``) });
    }
    items.push({ kind: "action", label: "Copy file path", onClick: () => navigator.clipboard.writeText(viewingFile) });
    items.push({ kind: "action", label: "Open in external editor", onClick: () => modus.openInEditor(viewingFile) });
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(...buildPinItems(viewingFile));
    }
    if (onSendToAgent) {
      items.push({ kind: "separator" });
      const snippet = sel ? `${viewingFile}\n\`\`\`\n${sel}\n\`\`\`` : viewingFile;
      items.push({ kind: "action", label: sel ? "Send selection to agent" : "Send reference to agent", onClick: () => onSendToAgent(snippet) });
    }
    markdownCtxMenu.open(e, items);
  }, [buildPinItems, groups.length, markdownCtxMenu, onSendToAgent, viewingFile]);

  const isHtml = viewingFile ? isHtmlFile(viewingFile) : false;
  const showFileContent = viewingFile && view.kind !== "idle";
  const showBrowser = activeView === "browser";
  const showPins = activeView === "pins";

  function renderContent() {
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

    if (showBrowser) return null;

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
            onMarkdownContextMenu={handleMarkdownContextMenu}
          />
        </div>
      );
    }

    return <div className="panel-empty">no file open</div>;
  }

  return (
    <div className="code-workspace-panel">
      <div
        className="cw-tabs"
        ref={tabsRef}
        onWheel={(e) => {
          if (!tabsRef.current) return;
          e.preventDefault();
          tabsRef.current.scrollLeft += e.deltaY + e.deltaX;
        }}
      >
        <div className={`cw-tab cw-tab--icon-only${showBrowser ? " cw-tab--active" : ""}`}>
          <button className="cw-tab-label" onClick={() => setActiveView("browser")} title="Project files">
            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
              <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
            </svg>
          </button>
        </div>
        <div className={`cw-tab cw-tab--icon-only${showPins ? " cw-tab--active" : ""}`}>
          <button className="cw-tab-label" onClick={() => setActiveView("pins")} title="Pinned files">
            <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
              <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill={showPins ? "currentColor" : "none"}/>
              <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`cw-tab${tab.path === activeView ? " cw-tab--active" : ""}${isFilePinned(tab.path) ? " cw-tab--pinned" : ""}${tab.dirty ? " cw-tab--dirty" : ""}`}
            onContextMenu={(e) => handleTabContextMenu(e, tab.path)}
          >
            <button className="cw-tab-label" onClick={() => setActiveView(tab.path)} title={tab.path}>
              {tab.dirty && <span className="cw-tab-dot" />}
              {isFilePinned(tab.path) && (
                <svg className="cw-tab-pin" width="7" height="7" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="currentColor"/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              )}
              {basename(tab.path)}
            </button>
            <button className="cw-tab-close" onClick={(e) => { e.stopPropagation(); handleCloseTab(tab.path); }} title="Close tab">
              <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
                <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        ))}
        <div className="cw-tabs-actions">
          {viewingFile && view.kind !== "directory" && !isImageFile(viewingFile) && (
            <button className={`right-panel-header-btn${isEditMode ? " active" : ""}`} onClick={handleToggleEdit} title={isEditMode ? "Switch to view" : "Edit file"}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
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
              {activeGroup && <span className="cw-pin-group">{activeGroup.name}</span>}
            </button>
          )}
          {!isEditMode && showFileContent && isHtml && view.kind === "file" && (
            <button className={`right-panel-header-btn${htmlPreview ? " active" : ""}`} onClick={() => setHtmlPreview(!htmlPreview)} title={htmlPreview ? "Show source" : "Show preview"}>
              {htmlPreview ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 3L1 6l3 3M8 3l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-3.5 5-3.5S11 6 11 6s-2 3.5-5 3.5S1 6 1 6z" stroke="currentColor" strokeWidth="1.1"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/></svg>
              )}
            </button>
          )}
          {fullscreen && (
            <button className={`right-panel-header-btn${fullscreenBrowser ? " active" : ""}`} onClick={() => setFullscreenBrowser((b) => !b)} title={fullscreenBrowser ? "Hide file browser" : "Show file browser"}>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.1" fill="none"/>
              </svg>
            </button>
          )}
          {(showFileContent || isEditMode) && (
            <button className="right-panel-header-btn" onClick={() => { setFullscreen(!fullscreen); if (fullscreen) setFullscreenBrowser(false); }} title={fullscreen ? "Exit fullscreen" : "Fullscreen"}>
              {fullscreen ? (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 1v3H1M8 11V8h3M1 8h3v3M11 4H8V1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 4V1h3M11 4V1H8M1 8v3h3M11 8v3H8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
              )}
            </button>
          )}
          {saving && <span className="rp-status rp-status--saving">saving...</span>}
          {saveError && <span className="rp-status rp-status--error">{saveError}</span>}
        </div>
      </div>

      <div className={`code-workspace-body${fullscreen && fullscreenBrowser ? " code-workspace-body--split" : ""}`}>
        {fullscreen && fullscreenBrowser && (
          <div className="code-workspace-fs-browser">
            <FileBrowser
              rootPath={activeCwd ?? null}
              initialPath={initialBrowserPath}
              onFileSelect={handleFileSelect}
              onPathChange={onBrowserPathChange}
            />
          </div>
        )}
        <div className={`code-workspace-content${isEditMode ? " code-workspace-content--editing" : ""}`}>
          {renderContent()}
          <div style={{ display: showBrowser ? "contents" : "none" }}>
            <FileBrowser
              rootPath={activeCwd ?? null}
              initialPath={initialBrowserPath}
              onFileSelect={handleFileSelect}
              onPathChange={onBrowserPathChange}
            />
          </div>
        </div>
      </div>
      {editorCtxMenu.portal}
      {tabCtxMenu.portal}
      {markdownCtxMenu.portal}
    </div>
  );
}
