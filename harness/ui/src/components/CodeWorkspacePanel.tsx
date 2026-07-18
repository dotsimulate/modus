import { useState, useEffect, useCallback, useDeferredValue, useRef } from "react";
import { createPortal } from "react-dom";
import { useFileViewer, type FileOpenRequest } from "../providers/FileViewerContext";
import { usePinboard } from "../providers/PinboardContext";
import { useProfiles } from "../providers/ProfileContext";
import { modus } from "../modusClient";
import type { BrowseResult, FileSearchResponse, PreviewManifest } from "../../../sdk/index";
import { setFsWatchRoot } from "../modusClient";
import { FileContentViewer } from "./FileContentViewer";
import { FileBrowser, type FileBrowserHandle } from "./FileBrowser";
import { CodeMirrorEditor, type CodeMirrorContextInfo } from "./CodeMirrorEditor";
import { CopyButton } from "./CopyButton";
import { DirectoryViewer } from "./DirectoryViewer";
import { HtmlPreview } from "./HtmlPreview";
import { PreviewRenderer } from "./PreviewRenderer";
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

const EMPTY_FILE_SEARCH: FileSearchResponse = {
  available: true,
  provider: "none",
  results: [],
};

export function CodeWorkspacePanel({ active = true, initialBrowserPath, onBrowserPathChange, onSendToAgent }: Props) {
  const {
    tabs, activePath, closeFile, openFile, subscribeFileOpens,
    setEditing, markDirty, saveFile, saving, saveError,
    contentVersion,
  } = useFileViewer();
  const { groups, pinToActive, pinToGroup, unpinFromActive, isFilePinned, activeGroup } = usePinboard();
  const { activeCwd, activeUserProfile } = useProfiles();

  useEffect(() => {
    setFsWatchRoot(activeCwd ?? null);
  }, [activeCwd]);

  const [activeView, setActiveView] = useState<ActiveView>("browser");
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [previewManifest, setPreviewManifest] = useState<PreviewManifest | null>(null);
  const [htmlPreview, setHtmlPreview] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [fileSearchQuery, setFileSearchQuery] = useState("");
  const deferredFileSearchQuery = useDeferredValue(fileSearchQuery);
  const [fileSearchState, setFileSearchState] = useState<FileSearchResponse>(EMPTY_FILE_SEARCH);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [tabsMenuPos, setTabsMenuPos] = useState<{ top: number; right: number } | null>(null);
  const [pendingReveal, setPendingReveal] = useState<{ request: FileOpenRequest; token: number } | null>(null);
  const prevTabsRef = useRef(tabs);
  const tabsRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fsBrowserRef = useRef<FileBrowserHandle>(null);
  const fullBrowserRef = useRef<FileBrowserHandle>(null);
  const tabsMenuWrapRef = useRef<HTMLDivElement>(null);
  const tabsMenuBtnRef = useRef<HTMLButtonElement>(null);

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

  useEffect(() => {
    if (!active || !activePath) return;
    if (tabs.some((tab) => tab.path === activePath)) {
      setActiveView(activePath);
    }
  }, [active, activePath, tabs]);

  useEffect(() => {
    return subscribeFileOpens((request) => {
      setPendingReveal((prev) => ({ request, token: (prev?.token ?? 0) + 1 }));
      if (request.path) setActiveView(request.path);
    });
  }, [subscribeFileOpens]);

  const viewingFile = activeView !== "browser" && activeView !== "pins" ? activeView : null;
  const activeTab = viewingFile ? tabs.find((t) => t.path === viewingFile) : null;
  const isEditMode = activeTab?.editing ?? false;
  const reveal = pendingReveal?.request.path === viewingFile ? pendingReveal : null;

  useEffect(() => {
    if (!viewingFile || isEditMode) { if (!viewingFile) { setView({ kind: "idle" }); setPreviewManifest(null); } return; }
    let active = true;
    setLoading(true);
    setView({ kind: "loading" });
    setPreviewManifest(null);

    (async () => {
      let previewFailure: unknown = null;
      try {
        const dirResult = await modus.browse(viewingFile, { includeHidden: true });
        if (active) setView({ kind: "directory", result: dirResult });
        return;
      } catch {
        try {
          const manifest = await modus.previewManifest(viewingFile, { cwd: activeCwd, userProfile: activeUserProfile ?? undefined });
          if (!active) return;
          setPreviewManifest(manifest);
          if (["image", "audio", "video", "pdf"].includes(manifest.kind)) {
            setView({ kind: "file", content: "" });
            return;
          }
        } catch (error) {
          previewFailure = error;
        }
        try {
          const text = await modus.readFile(viewingFile);
          if (!active) return;
          if (text !== null) { setView({ kind: "file", content: text }); return; }
        } catch {}
        if (active) {
          const detail = previewFailure instanceof Error ? previewFailure.message : "Preview request failed.";
          setView({ kind: "error", message: `Could not preview this path. ${detail}` });
        }
      }
    })().finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [viewingFile, isEditMode, contentVersion, activeCwd, activeUserProfile]);

  useEffect(() => {
    if (viewingFile) setHtmlPreview(true);
  }, [viewingFile]);

  useEffect(() => {
    const query = deferredFileSearchQuery.trim();
    if (!activeCwd || !query) {
      setFileSearchLoading(false);
      setFileSearchState(EMPTY_FILE_SEARCH);
      return;
    }

    let cancelled = false;
    setFileSearchLoading(true);

    const timer = window.setTimeout(() => {
      modus.searchFiles(activeCwd, query, 75)
        .then((result) => {
          if (!cancelled) setFileSearchState(result);
        })
        .catch((error) => {
          if (!cancelled) {
            setFileSearchState({
              available: false,
              provider: "none",
              installHint: error instanceof Error ? error.message : "file search failed",
              results: [],
            });
          }
        })
        .finally(() => {
          if (!cancelled) setFileSearchLoading(false);
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeCwd, deferredFileSearchQuery]);

  const handleCloseFile = () => {
    if (viewingFile) closeFile(viewingFile);
    setActiveView("browser");
  };

  const handleCloseTab = (path: string) => {
    closeFile(path);
    if (activeView === path) setActiveView("browser");
  };

  const handleFileSelect = (path: string) => {
    openFile(path, { source: "browser" });
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

  const editBtn = (
    <button
      className={`chat-file-viewer-btn${isEditMode ? " active" : ""}`}
      onClick={handleToggleEdit}
      title={isEditMode ? "Switch to view" : "Edit file"}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
        <path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/>
      </svg>
    </button>
  );

  const canEdit = (targetPath: string) => view.kind !== "directory" && !isImageFile(targetPath);

  const fileActions = (targetPath: string) => (
    <>
      {canEdit(targetPath) && editBtn}
      {saving && <span className="rp-status rp-status--saving">saving...</span>}
      {saveError && <span className="rp-status rp-status--error">{saveError}</span>}
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
    items.push({ kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(info.path) });
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

  const handleRevealInTree = useCallback((path: string) => {
    if (!sidebarOpen) setSidebarOpen(true);
    // Defer so the sidebar mounts its FileBrowser before we call revealPath.
    window.setTimeout(() => {
      const ref = fsBrowserRef.current ?? fullBrowserRef.current;
      ref?.revealPath(path);
    }, 60);
  }, [sidebarOpen]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabPath: string) => {
    const items: ContextMenuItem[] = [
      { kind: "action", label: "Reveal in tree", onClick: () => handleRevealInTree(tabPath) },
      { kind: "separator" },
      { kind: "action", label: "Close", onClick: () => handleCloseTab(tabPath) },
      { kind: "action", label: "Close others", disabled: tabs.length <= 1, onClick: () => tabs.filter(t => t.path !== tabPath).forEach(t => closeFile(t.path)) },
      { kind: "action", label: "Close all", disabled: tabs.length === 0, onClick: () => { tabs.forEach(t => closeFile(t.path)); setActiveView("browser"); } },
      { kind: "separator" },
      { kind: "action", label: "Copy path", onClick: () => navigator.clipboard.writeText(tabPath) },
      { kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(tabPath) },
      { kind: "action", label: "Open in external editor", onClick: () => modus.openInEditor(tabPath) },
    ];
    if (groups.length > 0) {
      items.push({ kind: "separator" });
      items.push(...buildPinItems(tabPath));
    }
    tabCtxMenu.open(e, items);
  }, [buildPinItems, closeFile, groups.length, handleRevealInTree, tabCtxMenu, tabs]);

  const handleMarkdownContextMenu = useCallback((e: React.MouseEvent) => {
    if (!viewingFile) return;
    const items: ContextMenuItem[] = [];
    const sel = window.getSelection()?.toString() ?? "";
    if (sel) {
      items.push({ kind: "action", label: "Copy selection", onClick: () => navigator.clipboard.writeText(sel) });
      items.push({ kind: "action", label: "Copy as code block", onClick: () => navigator.clipboard.writeText(`\`\`\`\n${sel}\n\`\`\``) });
    }
    items.push({ kind: "action", label: "Copy file path", onClick: () => navigator.clipboard.writeText(viewingFile) });
    items.push({ kind: "action", label: "Open in folder", onClick: () => modus.openInFolder(viewingFile) });
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
  const showFileSearchResults = showBrowser && searchOpen && fileSearchQuery.trim().length > 0;
  const rootName = activeCwd ? basename(activeCwd) : null;

  useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => searchInputRef.current?.focus());
    }
  }, [searchOpen]);

  useEffect(() => {
    if (!showBrowser && searchOpen) setSearchOpen(false);
  }, [showBrowser, searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setFileSearchQuery("");
    setFileSearchState(EMPTY_FILE_SEARCH);
  };

  const handleCollapseAll = () => {
    fsBrowserRef.current?.collapseAll();
    fullBrowserRef.current?.collapseAll();
  };

  // ── Tabs overflow detection ──
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const check = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener("scroll", check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, [tabs.length, searchOpen, activeView]);

  useEffect(() => {
    if (!tabsOverflow && tabsMenuOpen) setTabsMenuOpen(false);
  }, [tabsOverflow, tabsMenuOpen]);

  useEffect(() => {
    if (!tabsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (tabsMenuWrapRef.current?.contains(target)) return;
      const portalMenu = document.querySelector(".cw-tabs-overflow-menu--portal");
      if (portalMenu?.contains(target)) return;
      setTabsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabsMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tabsMenuOpen]);

  function renderSearchResults() {
    if (!showFileSearchResults) return null;
    return (
      <div className="cw-search-results">
        {fileSearchLoading ? (
          <div className="cw-search-state">searching...</div>
        ) : !fileSearchState.available ? (
          <div className="cw-search-state">
            {fileSearchState.installHint ?? "Workspace search is unavailable."}
          </div>
        ) : fileSearchState.results.length === 0 ? (
          <div className="cw-search-state">no matching files</div>
        ) : (
          fileSearchState.results.map((result) => (
            <button
              key={result.path}
              className="cw-search-result"
              onClick={() => {
                handleFileSelect(result.path);
                closeSearch();
              }}
              title={result.path}
            >
              <span className="cw-search-result-name">{result.name}</span>
              <span className="cw-search-result-path">{result.parent}</span>
            </button>
          ))
        )}
      </div>
    );
  }

  function renderContent() {
    if (showPins) {
      return (
        <PinboardView
          onOpenFile={(path) => {
            openFile(path, { source: "browser" });
            setActiveView(path);
          }}
        />
      );
    }

    if (isEditMode && viewingFile) {
      if (activeTab?.content !== null) {
        return (
          <div className="right-panel-editor">
            <div className="fcv-head">
              <div className="fcv-meta">
                <div className="fcv-name-row">
                  <span className="fcv-name">{basename(viewingFile)}</span>
                  <div className="fcv-name-actions">{copyPathBtn(viewingFile)}</div>
                </div>
              </div>
              <div className="fcv-head-side">
                <div className="fcv-actions">{fileActions(viewingFile)}</div>
              </div>
            </div>
            <CodeMirrorEditor
              key={viewingFile}
              content={activeTab!.content!}
              path={viewingFile}
              revealLine={reveal?.request.line}
              revealEndLine={reveal?.request.endLine}
              revealToken={reveal?.token}
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

    if (!isEditMode && viewingFile && previewManifest && ["image", "audio", "video", "pdf"].includes(previewManifest.kind)) {
      return (
        <PreviewRenderer
          manifest={previewManifest}
          nameActions={copyPathBtn(viewingFile)}
          actions={fileActions(viewingFile)}
        />
      );
    }

    if (!isEditMode && showFileContent && isHtml && htmlPreview && view.kind === "file" && !previewManifest) {
      return (
        <HtmlPreview
          filePath={viewingFile!}
          content={view.content}
          nameActions={copyPathBtn(viewingFile!)}
          actions={fileActions(viewingFile!)}
        />
      );
    }

    if (!isEditMode && showFileContent && previewManifest?.kind === "html" && htmlPreview) {
      return (
        <PreviewRenderer
          manifest={previewManifest}
          content={view.kind === "file" ? view.content : null}
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
            onRequestEdit={canEdit(viewingFile!) ? handleToggleEdit : undefined}
            revealLine={reveal?.request.line}
            revealEndLine={reveal?.request.endLine}
            revealToken={reveal?.token}
          />
        </div>
      );
    }

    return <div className="panel-empty">no file open</div>;
  }

  return (
    <div className="code-workspace-panel">
      <div className="cw-tabs-header">
        <div
          className="cw-tabs"
          ref={tabsRef}
          onWheel={(e) => {
            if (!tabsRef.current) return;
            e.preventDefault();
            tabsRef.current.scrollLeft += e.deltaY + e.deltaX;
          }}
        >
          {showBrowser && searchOpen ? (
            <div className="cw-search-inline">
              <span className="cw-search-inline-icon" aria-hidden>
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2" />
                  <path d="M7.7 7.7L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </span>
              <input
                ref={searchInputRef}
                className="cw-search-inline-input"
                value={fileSearchQuery}
                placeholder={rootName ? `search in ${rootName}...` : "search files..."}
                onChange={(e) => setFileSearchQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") closeSearch(); }}
              />
              <button className="cw-search-inline-close" onClick={closeSearch} title="Close search">
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ) : showBrowser && rootName ? (
            <div className={`cw-tab cw-tab--root${showBrowser ? " cw-tab--active" : ""}`}>
              <button className="cw-tab-label" onClick={() => setActiveView("browser")} title={activeCwd ?? "Project files"}>
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                  <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                </svg>
                <span className="cw-tab-root-name">{rootName}</span>
              </button>
            </div>
          ) : (
            <div className={`cw-tab cw-tab--icon-only${showBrowser ? " cw-tab--active" : ""}`}>
              <button className="cw-tab-label" onClick={() => setActiveView("browser")} title="Project files">
                <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                  <path d="M1 3h4l1-1.5h5v8.5H1z" stroke="currentColor" strokeWidth="1.2" fill="none"/>
                </svg>
              </button>
            </div>
          )}
          {!(showBrowser && searchOpen) && (
            <div className={`cw-tab cw-tab--icon-only${showPins ? " cw-tab--active" : ""}`}>
              <button className="cw-tab-label" onClick={() => setActiveView("pins")} title="Pinned files">
                <svg width="8" height="8" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill={showPins ? "currentColor" : "none"}/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          )}
          {!(showBrowser && searchOpen) && tabs.map((tab) => (
            <div
              key={tab.path}
              data-tab-path={tab.path}
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
        </div>
        <div className="cw-tabs-actions">
          {tabsOverflow && !searchOpen && tabs.length > 0 && (
            <div className="cw-tabs-overflow-wrap" ref={tabsMenuWrapRef}>
              <button
                ref={tabsMenuBtnRef}
                className={`right-panel-header-btn${tabsMenuOpen ? " active" : ""}`}
                onClick={() => {
                  setTabsMenuOpen((v) => {
                    if (!v && tabsMenuBtnRef.current) {
                      const rect = tabsMenuBtnRef.current.getBoundingClientRect();
                      setTabsMenuPos({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
                    }
                    return !v;
                  });
                }}
                title="All open tabs"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M2 4L6 8L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          )}
          {!searchOpen && activeCwd && (
            <button
              className={`right-panel-header-btn${sidebarOpen ? " active" : ""}`}
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <rect x="1" y="1.5" width="10" height="9" rx="1" stroke="currentColor" strokeWidth="1.1" fill="none"/>
                <path d="M4.5 1.5v9" stroke="currentColor" strokeWidth="1.1"/>
              </svg>
            </button>
          )}
          {showBrowser && !searchOpen && activeCwd && (
            <>
              <button className="right-panel-header-btn" onClick={handleCollapseAll} title="Collapse all">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M1.5 6L6 1.5L10.5 6M3 5v5.5h2.25V8h1.5v2.5H9V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button className="right-panel-header-btn" onClick={() => setSearchOpen(true)} title="Search files">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M7.7 7.7L10.5 10.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
              <button className="right-panel-header-btn" onClick={() => modus.openInFolder(activeCwd)} title="Open in file explorer">
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </>
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
        </div>
      </div>

      <div className={`code-workspace-body${sidebarOpen ? " code-workspace-body--split" : ""}`}>
        {sidebarOpen && (
          <div className="code-workspace-fs-browser">
            <FileBrowser
              ref={fsBrowserRef}
              hideHeader
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
            <div className="code-workspace-browser-view">
              {showBrowser && searchOpen && renderSearchResults()}
              {sidebarOpen ? (
                <div className="cw-browser-placeholder">
                  <div className="cw-browser-placeholder-hint">
                    <span>Open a file from the tree on the left, or</span>
                    <button className="cw-browser-placeholder-link" onClick={() => setActiveView("pins")}>view pinned files</button>
                  </div>
                </div>
              ) : (
                <FileBrowser
                  ref={fullBrowserRef}
                  hideHeader
                  rootPath={activeCwd ?? null}
                  initialPath={initialBrowserPath}
                  onFileSelect={handleFileSelect}
                  onPathChange={onBrowserPathChange}
                />
              )}
            </div>
          </div>
        </div>
      </div>
      {editorCtxMenu.portal}
      {tabCtxMenu.portal}
      {markdownCtxMenu.portal}
      {tabsMenuOpen && tabsMenuPos && createPortal(
        <div
          className="cw-tabs-overflow-menu cw-tabs-overflow-menu--portal"
          role="menu"
          style={{ top: tabsMenuPos.top, right: tabsMenuPos.right }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.path}
              className={`cw-tabs-overflow-item${tab.path === activeView ? " cw-tabs-overflow-item--active" : ""}${tab.dirty ? " cw-tabs-overflow-item--dirty" : ""}`}
              onClick={() => {
                setActiveView(tab.path);
                setTabsMenuOpen(false);
                requestAnimationFrame(() => {
                  const safe = (typeof CSS !== "undefined" && typeof CSS.escape === "function") ? CSS.escape(tab.path) : tab.path;
                  tabsRef.current?.querySelector<HTMLElement>(`[data-tab-path="${safe}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
                });
              }}
              onContextMenu={(e) => { handleTabContextMenu(e, tab.path); setTabsMenuOpen(false); }}
              title={tab.path}
            >
              {tab.dirty && <span className="cw-tab-dot" />}
              {isFilePinned(tab.path) && (
                <svg className="cw-tabs-overflow-pin" width="8" height="8" viewBox="0 0 12 12" fill="none">
                  <path d="M7.5 1.5L10.5 4.5L7 8L5 10L4 9L2 7L3 6L5 2.5L7.5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="currentColor"/>
                  <path d="M2 10L4 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              )}
              <span className="cw-tabs-overflow-name">{basename(tab.path)}</span>
              <span className="cw-tabs-overflow-path">{tab.path}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
