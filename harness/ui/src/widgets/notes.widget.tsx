import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ExternalLink, Folder, FolderOpen, Plus, RefreshCw } from "lucide-react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import type { BrowseResult } from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetUiState } from "./ui-state";

type NotesWidgetConfig = WidgetBase & {
  type: "notes";
  initialFolder?: string;
  extensions?: string[];
  createFolderIfMissing?: boolean;
};

type NoteSummary = {
  path: string;
  filename: string;
  title: string;
  preview: string;
};

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];

function normalizePath(value: string): string {
  const withSlashes = value.replace(/\\/g, "/");
  if (withSlashes === "/") return "/";
  return withSlashes.replace(/\/+$/, "");
}

function joinPath(base: string, child: string): string {
  const left = normalizePath(base);
  const right = child.replace(/^[/\\]+/, "");
  if (!right) return left;
  return left === "/" ? `/${right}` : `${left}/${right}`;
}

function isWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
}

function resolveFolderPath(root: string, rawFolder?: string): string {
  if (!rawFolder?.trim()) return normalizePath(root);
  const normalizedRoot = normalizePath(root);
  const candidate = rawFolder.match(/^(?:\/|[A-Za-z]:[/\\])/)
    ? normalizePath(rawFolder)
    : joinPath(normalizedRoot, rawFolder);
  return isWithinRoot(normalizedRoot, candidate) ? candidate : normalizedRoot;
}

function relativePath(root: string, target: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (normalizedTarget === normalizedRoot) return "/";
  return normalizedTarget.slice(normalizedRoot.length + 1) || "/";
}

function basename(path: string): string {
  const parts = normalizePath(path).split("/");
  return parts[parts.length - 1] || path;
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

function formatFallbackTitle(filename: string): string {
  return stem(filename)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "New Note";
}

function extractTitle(content: string, filename: string): string {
  const line = content
    .split(/\r?\n/)
    .map((value) => value.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return line || formatFallbackTitle(filename);
}

function extractPreview(content: string, title: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (lines.length === 0) return "Empty note";
  const joined = lines.join(" ");
  const trimmed = joined.startsWith(title) ? joined.slice(title.length).trim() : joined;
  const preview = trimmed || joined;
  return preview.length > 140 ? `${preview.slice(0, 137)}...` : preview;
}

function buildSummary(path: string, content: string): NoteSummary {
  const filename = basename(path);
  const title = extractTitle(content, filename);
  return {
    path,
    filename,
    title,
    preview: extractPreview(content, title),
  };
}

function timestampFragment(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function buildNewNotePath(folderPath: string): string {
  return joinPath(folderPath, `note-${timestampFragment(new Date())}.md`);
}

export default function NotesWidget({ config, widgetId, active = true }: WidgetProps<NotesWidgetConfig>) {
  const { activeUserProfile, activeCwd, projectRoot } = useProfiles();
  const rootPath = projectRoot ?? activeCwd ?? null;
  const defaultFolder = rootPath ? resolveFolderPath(rootPath, config.initialFolder) : "";
  const allowedExtensions = (config.extensions?.length ? config.extensions : DEFAULT_EXTENSIONS)
    .map((value) => value.toLowerCase());

  const [folderPath, setFolderPath] = useWidgetUiState(
    { userProfile: activeUserProfile, cwd: rootPath ?? activeCwd },
    widgetId,
    "folder-path",
    defaultFolder,
  );
  const [selectedPath, setSelectedPath] = useWidgetUiState<string | null>(
    { userProfile: activeUserProfile, cwd: rootPath ?? activeCwd },
    widgetId,
    "selected-path",
    null,
  );
  const [search, setSearch] = useWidgetUiState(
    { userProfile: activeUserProfile, cwd: rootPath ?? activeCwd },
    widgetId,
    "search",
    "",
  );

  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPath, setPickerPath] = useState("");
  const [pickerResult, setPickerResult] = useState<BrowseResult | null>(null);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [mobileEditor, setMobileEditor] = useState(false);

  const loadSeqRef = useRef(0);
  const editorSeqRef = useRef(0);
  const saveSeqRef = useRef(0);
  const selectedPathRef = useRef<string | null>(selectedPath);
  const draftRef = useRef(draft);
  const savedDraftRef = useRef(savedDraft);

  useEffect(() => {
    selectedPathRef.current = selectedPath;
  }, [selectedPath]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    savedDraftRef.current = savedDraft;
  }, [savedDraft]);

  useEffect(() => {
    if (!rootPath) return;
    const nextFolder = resolveFolderPath(rootPath, config.initialFolder);
    if (!folderPath || !isWithinRoot(rootPath, folderPath)) {
      setFolderPath(nextFolder);
    }
  }, [config.initialFolder, folderPath, rootPath, setFolderPath]);

  useEffect(() => {
    if (!selectedPath) {
      setMobileEditor(false);
    }
  }, [selectedPath]);

  async function saveNote(path: string, content: string) {
    const currentSave = ++saveSeqRef.current;
    setSaveState("saving");
    setSaveError("");
    const saved = await modus.writeFile(path, content);
    if (currentSave !== saveSeqRef.current) return saved.ok;
    if (saved.ok) {
      setSavedDraft(content);
      setSaveState("saved");
      setSaveError("");
      setNotes((prev) =>
        prev
          .map((note) => (note.path === path ? buildSummary(path, content) : note))
          .sort((a, b) => b.filename.localeCompare(a.filename)),
      );
      return true;
    }
    setSaveState("error");
    setSaveError(saved.error ?? "Could not save note.");
    return false;
  }

  async function flushCurrentDraft() {
    const path = selectedPathRef.current;
    if (!path || draftRef.current === savedDraftRef.current) return true;
    return saveNote(path, draftRef.current);
  }

  async function loadFolder(targetFolder: string, nextSelectedPath?: string | null) {
    if (!rootPath) return;
    const currentLoad = ++loadSeqRef.current;
    setLoadingList(true);
    setListError("");
    try {
      let result: BrowseResult;
      try {
        result = await modus.browse(targetFolder, { includeFiles: true });
      } catch (error) {
        if (!config.createFolderIfMissing) throw error;
        const created = await modus.createDirectory(targetFolder);
        // A collision means someone else created it between the failed browse
        // and now, which is the outcome this branch wanted anyway.
        if (!created.ok && created.code !== "collision") throw new Error(created.error ?? String(error));
        result = await modus.browse(targetFolder, { includeFiles: true });
      }

      const matchingFiles = (result.files ?? [])
        .filter((name) => allowedExtensions.some((ext) => name.toLowerCase().endsWith(ext)))
        .sort((a, b) => b.localeCompare(a));
      const items = await Promise.all(
        matchingFiles.map(async (filename) => {
          const path = joinPath(result.path, filename);
          const content = await modus.readFile(path);
          return buildSummary(path, content ?? "");
        }),
      );

      if (currentLoad !== loadSeqRef.current) return;
      setNotes(items);

      const nextPath = nextSelectedPath && items.some((note) => note.path === nextSelectedPath)
        ? nextSelectedPath
        : selectedPathRef.current && items.some((note) => note.path === selectedPathRef.current)
          ? selectedPathRef.current
          : items[0]?.path ?? null;
      setSelectedPath(nextPath);
    } catch (error: any) {
      if (currentLoad !== loadSeqRef.current) return;
      setNotes([]);
      setListError(error?.message || "Could not load this folder.");
      setSelectedPath(null);
    } finally {
      if (currentLoad === loadSeqRef.current) {
        setLoadingList(false);
      }
    }
  }

  useEffect(() => {
    if (!rootPath || !folderPath) return;
    void loadFolder(folderPath);
  }, [folderPath, rootPath]);

  useEffect(() => {
    if (!active || !selectedPath) {
      if (!selectedPath) {
        setDraft("");
        setSavedDraft("");
        setSaveState("idle");
        setSaveError("");
      }
      return;
    }

    const currentLoad = ++editorSeqRef.current;
    setEditorLoading(true);
    setSaveState("idle");
    setSaveError("");

    modus.readFile(selectedPath)
      .then((content) => {
        if (currentLoad !== editorSeqRef.current) return;
        const next = content ?? "";
        setDraft(next);
        setSavedDraft(next);
      })
      .catch(() => {
        if (currentLoad !== editorSeqRef.current) return;
        setDraft("");
        setSavedDraft("");
        setSaveState("error");
        setSaveError("Could not open note.");
      })
      .finally(() => {
        if (currentLoad === editorSeqRef.current) {
          setEditorLoading(false);
        }
      });
  }, [active, selectedPath]);

  useEffect(() => {
    if (!selectedPath || !active) return;
    if (draft === savedDraft) return;
    const timer = window.setTimeout(() => {
      void saveNote(selectedPath, draft);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [active, draft, savedDraft, selectedPath]);

  useEffect(() => {
    if (!pickerOpen || !pickerPath || !rootPath) return;
    setPickerLoading(true);
    modus.browse(pickerPath)
      .then((result) => {
        if (!isWithinRoot(rootPath, result.path)) return;
        setPickerResult(result);
      })
      .catch(() => {
        setPickerResult(null);
      })
      .finally(() => {
        setPickerLoading(false);
      });
  }, [pickerOpen, pickerPath, rootPath]);

  async function handleSelectNote(path: string) {
    if (path === selectedPathRef.current) {
      setMobileEditor(true);
      return;
    }
    await flushCurrentDraft();
    setSelectedPath(path);
    setMobileEditor(true);
  }

  async function handleCreateNote() {
    if (!folderPath) return;
    await flushCurrentDraft();
    const path = buildNewNotePath(folderPath);
    const created = await modus.createFile(path, "");
    if (!created.ok) {
      setSaveState("error");
      setSaveError(created.error ?? "Could not create note.");
      return;
    }
    setSelectedPath(path);
    setDraft("");
    setSavedDraft("");
    setSaveState("idle");
    setSaveError("");
    setMobileEditor(true);
    await loadFolder(folderPath, path);
  }

  async function handleRefresh() {
    if (!folderPath) return;
    await flushCurrentDraft();
    await loadFolder(folderPath, selectedPathRef.current);
  }

  async function handleFolderChange(nextFolder: string) {
    if (!rootPath || !isWithinRoot(rootPath, nextFolder)) return;
    await flushCurrentDraft();
    setFolderPath(nextFolder);
    setPickerOpen(false);
    setPickerPath(nextFolder);
    setMobileEditor(false);
  }

  function openFolderPicker() {
    if (!rootPath) return;
    setPickerPath(folderPath || defaultFolder || rootPath);
    setPickerOpen(true);
  }

  const visibleNotes = notes.filter((note) => {
    const query = search.trim().toLowerCase();
    if (!query) return true;
    return `${note.title}\n${note.preview}\n${note.filename}`.toLowerCase().includes(query);
  });

  const selectedSummary = notes.find((note) => note.path === selectedPath) ?? null;
  const noteCountLabel = `${visibleNotes.length} note${visibleNotes.length === 1 ? "" : "s"}`;
  const dirty = selectedPath != null && draft !== savedDraft;

  if (!rootPath) {
    return <div className="dash-empty">select a project to open notes</div>;
  }

  return (
    <div className={`notes-widget${mobileEditor ? " notes-widget--mobile-editor" : ""}`}>
      <aside className="notes-sidebar">
        <div className="notes-toolbar">
          <div className="notes-toolbar-main">
            <button className="notes-chip" onClick={openFolderPicker} type="button">
              <Folder size={14} strokeWidth={1.8} />
              <span>{relativePath(rootPath, folderPath || rootPath)}</span>
            </button>
            <button className="notes-toolbar-btn" onClick={() => void handleRefresh()} type="button" title="Refresh notes">
              <RefreshCw size={14} strokeWidth={1.8} />
            </button>
          </div>
          <button className="notes-primary-btn" onClick={() => void handleCreateNote()} type="button" title="New note" aria-label="New note">
            <Plus size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="notes-sidebar-head">
          <div>
            <div className="notes-eyebrow">Notes</div>
            <div className="notes-count">{noteCountLabel}</div>
          </div>
          <div className="notes-root-label">{basename(rootPath)}</div>
        </div>

        <label className="notes-search">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search notes"
            spellCheck={false}
          />
        </label>

        <div className="notes-list">
          {loadingList && <div className="notes-empty">Loading notes...</div>}
          {!loadingList && listError && <div className="notes-empty notes-empty--error">{listError}</div>}
          {!loadingList && !listError && visibleNotes.length === 0 && (
            <div className="notes-empty">
              {notes.length === 0 ? "No notes in this folder yet." : "No notes match that search."}
            </div>
          )}
          {!loadingList && !listError && visibleNotes.map((note) => (
            <button
              key={note.path}
              className={`notes-list-item${note.path === selectedPath ? " is-active" : ""}`}
              onClick={() => void handleSelectNote(note.path)}
              type="button"
            >
              <div className="notes-list-item-title">{note.title}</div>
              <div className="notes-list-item-preview">{note.preview}</div>
              <div className="notes-list-item-meta">{note.filename}</div>
            </button>
          ))}
        </div>
      </aside>

      <section className="notes-editor-pane">
        {selectedPath ? (
          <>
            <div className="notes-editor-head">
              <div className="notes-editor-title-row">
                <button className="notes-back-btn" onClick={() => setMobileEditor(false)} type="button">
                  <ChevronLeft size={16} strokeWidth={2} />
                </button>
                <div className="notes-editor-titles">
                  <div className="notes-editor-title">{selectedSummary?.title ?? formatFallbackTitle(basename(selectedPath))}</div>
                  <div className="notes-editor-meta">
                    <span>{relativePath(rootPath, selectedPath)}</span>
                    <span className={`notes-save-state notes-save-state--${saveState}`}>
                      {saveState === "saving" ? "Saving..." : saveState === "error" ? saveError || "Save failed" : dirty ? "Unsaved" : "Saved"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="notes-editor-actions">
                <button
                  className="notes-toolbar-btn"
                  onClick={() => selectedPath && modus.openInEditor(selectedPath)}
                  type="button"
                  title="Open in editor"
                >
                  <ExternalLink size={14} strokeWidth={1.8} />
                </button>
              </div>
            </div>

            <div className="notes-editor-body">
              {editorLoading ? (
                <div className="notes-empty">Loading note...</div>
              ) : (
                <textarea
                  className="notes-editor"
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (saveState !== "saving") setSaveState("idle");
                  }}
                  placeholder="Start writing..."
                  spellCheck
                />
              )}
            </div>
          </>
        ) : (
          <div className="notes-editor-placeholder">
            <div className="notes-placeholder-card">
              <FolderOpen size={20} strokeWidth={1.8} />
              <div className="notes-placeholder-title">Pick or create a note</div>
              <div className="notes-placeholder-copy">
                Plain project files, simple list on the left, clean writing surface on the right.
              </div>
            </div>
          </div>
        )}
      </section>

      {pickerOpen && (
        <div className="notes-folder-sheet" role="dialog" aria-modal="true">
          <div className="notes-folder-backdrop" onClick={() => setPickerOpen(false)} />
          <div className="notes-folder-panel">
            <div className="notes-folder-head">
              <div>
                <div className="notes-eyebrow">Choose folder</div>
                <div className="notes-folder-path">{relativePath(rootPath, pickerPath || rootPath)}</div>
              </div>
              <button className="notes-toolbar-btn" onClick={() => setPickerOpen(false)} type="button">
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
            </div>

            <div className="notes-folder-list">
              {pickerLoading && <div className="notes-empty">Loading folders...</div>}
              {!pickerLoading && pickerResult && pickerResult.path !== rootPath && pickerResult.parent && isWithinRoot(rootPath, pickerResult.parent) && (
                <button className="notes-folder-item notes-folder-item--parent" onClick={() => setPickerPath(pickerResult.parent!)} type="button">
                  ..
                </button>
              )}
              {!pickerLoading && pickerResult?.dirs.map((dir) => {
                const target = joinPath(pickerResult.path, dir);
                return (
                  <button
                    key={target}
                    className="notes-folder-item"
                    onClick={() => setPickerPath(target)}
                    type="button"
                  >
                    <Folder size={14} strokeWidth={1.8} />
                    <span>{dir}</span>
                  </button>
                );
              })}
              {!pickerLoading && pickerResult && pickerResult.dirs.length === 0 && (
                <div className="notes-empty">No subfolders here.</div>
              )}
            </div>

            <button className="notes-folder-select" onClick={() => void handleFolderChange(pickerPath || rootPath)} type="button">
              Use {relativePath(rootPath, pickerPath || rootPath)}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
