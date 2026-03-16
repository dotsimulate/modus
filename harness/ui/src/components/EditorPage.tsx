/**
 * EditorPage — IDE-style editor view.
 *
 * Left:   FileBrowser (resizable, no inline preview)
 * Center: CodeMirror 6 with .rp-tab* tab bar, Ctrl+S saves
 * Right:  Git info for the active file (status + diff hunks)
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { useProfiles } from "../providers/ProfileProvider";
import { FileBrowser } from "./FileBrowser";
import { ResizeHandle } from "./ResizeHandle";
import { readFileContent, writeFileContent } from "../api";
import { fetchGitStatus, fetchGitFileDiff } from "../api/git";
import type { FileDiff, GitStatus } from "../api/types";

// ── Language detection ──

function langFromPath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return javascript({ jsx: true });
    case "ts": case "tsx": return javascript({ jsx: true, typescript: true });
    case "css": return css();
    case "json": return json();
    case "md": case "markdown": return markdown();
    case "html": case "htm": return html();
    case "py": return python();
    default: return [];
  }
}

// ── MO dark theme ──

const moTheme = EditorView.theme({
  "&": {
    background: "var(--bg)",
    color: "var(--text-secondary)",
    height: "100%",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
    lineHeight: "1.6",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "14px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    background: "rgba(255,255,255,0.08)",
  },
  ".cm-gutters": {
    background: "var(--bg-raised)",
    borderRight: "1px solid var(--border)",
    color: "var(--text-muted)",
    minWidth: "44px",
  },
  ".cm-activeLineGutter": { background: "rgba(255,255,255,0.03)", color: "var(--text-dim)" },
  ".cm-activeLine": { background: "rgba(255,255,255,0.02)" },
  ".cm-lineNumbers .cm-gutterElement": { paddingRight: "14px", textAlign: "right" },
  ".cm-scroller": { overflow: "auto" },
}, { dark: true });

// ── CodeMirror editor ──

function CodeMirrorEditor({
  content, path, onSave, onDirty,
}: {
  content: string;
  path: string;
  onSave: (content: string) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onDirtyRef = useRef(onDirty);
  onSaveRef.current = onSave;
  onDirtyRef.current = onDirty;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          { key: "Mod-s", run(view) { onSaveRef.current(view.state.doc.toString()); return true; } },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        langFromPath(path),
        moTheme,
        EditorView.updateListener.of((u) => { if (u.docChanged) onDirtyRef.current(true); }),
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={containerRef} className="editor-cm-container" />;
}

// ── Git file info panel ──

function fileStatus(status: GitStatus | null, relPath: string): "M" | "S" | "?" | null {
  if (!status?.files) return null;
  if (status.files.staged.includes(relPath)) return "S";
  if (status.files.modified.includes(relPath)) return "M";
  if (status.files.untracked.includes(relPath)) return "?";
  return null;
}

function GitFilePanel({ cwd, filePath }: { cwd: string; filePath: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [diff, setDiff] = useState<FileDiff[] | null>(null);
  const [loading, setLoading] = useState(false);

  const relPath = filePath.startsWith(cwd + "/") ? filePath.slice(cwd.length + 1) : filePath;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setDiff(null);

    Promise.all([
      fetchGitStatus(cwd).catch(() => null),
      fetchGitFileDiff(cwd, relPath).catch(() => null),
    ]).then(([s, d]) => {
      if (!active) return;
      setStatus(s);
      setDiff(d);
      setLoading(false);
    });

    return () => { active = false; };
  }, [cwd, relPath]);

  const st = fileStatus(status, relPath);
  const fileDiff = diff?.[0] ?? null;

  return (
    <div className="editor-git-panel">
      {/* Header */}
      <div className="editor-git-head">
        <span className="editor-git-branch">
          {status?.git ? (
            <>
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="3" cy="3" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <circle cx="3" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <circle cx="9" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M3 4.8V7.2M3 4.8C4.5 4.8 7.2 4.2 7.2 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
              {status.branch ?? "HEAD"}
            </>
          ) : "no git"}
        </span>
        {st && (
          <span className={`editor-git-badge editor-git-badge--${st === "S" ? "staged" : st === "?" ? "untracked" : "modified"}`}>
            {st === "S" ? "staged" : st === "?" ? "untracked" : "modified"}
          </span>
        )}
      </div>

      {/* File path */}
      <div className="editor-git-path">{relPath}</div>

      {/* Diff */}
      <div className="editor-git-body">
        {loading && <div className="editor-git-empty">loading…</div>}
        {!loading && !fileDiff && <div className="editor-git-empty">no changes</div>}
        {fileDiff && (
          <>
            <div className="editor-git-stats">
              <span className="editor-git-add">+{fileDiff.additions}</span>
              <span className="editor-git-del">−{fileDiff.deletions}</span>
            </div>
            {fileDiff.hunks.map((hunk, hi) => (
              <div key={hi} className="editor-git-hunk">
                <div className="editor-git-hunk-header">{hunk.header}</div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={`editor-git-line editor-git-line--${line.type}`}
                  >
                    <span className="editor-git-line-num">
                      {line.type === "add" ? line.newNum : line.type === "del" ? line.oldNum : line.newNum}
                    </span>
                    <span className="editor-git-line-content">{line.content}</span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Open file state ──

type OpenFile = { path: string; content: string; dirty: boolean };

function basename(p: string) {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

// ── EditorPage ──

const MIN_LEFT = 140;
const MAX_LEFT = 500;
const MIN_RIGHT = 160;
const MAX_RIGHT = 420;

export function EditorPage() {
  const { activeCwd } = useProfiles();
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(240);
  const [showGit, setShowGit] = useState(true);

  const activeFile = openFiles.find((f) => f.path === activePath) ?? null;

  const handleFileSelect = useCallback(async (path: string) => {
    if (openFiles.some((f) => f.path === path)) {
      setActivePath(path);
      return;
    }
    const content = await readFileContent(path);
    if (content === null) return;
    setOpenFiles((prev) => [...prev, { path, content, dirty: false }]);
    setActivePath(path);
  }, [openFiles]);

  const handleClose = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((f) => f.path !== path);
      if (activePath === path) setActivePath(next[next.length - 1]?.path ?? null);
      return next;
    });
  }, [activePath]);

  const handleSave = useCallback(async (content: string) => {
    if (!activePath) return;
    setSaving(true);
    setSaveError(null);
    const ok = await writeFileContent(activePath, content);
    setSaving(false);
    if (ok) {
      setOpenFiles((prev) => prev.map((f) => f.path === activePath ? { ...f, content, dirty: false } : f));
    } else {
      setSaveError("save failed");
    }
  }, [activePath]);

  const handleDirty = useCallback((dirty: boolean) => {
    setActivePath((path) => {
      if (path) setOpenFiles((prev) => prev.map((f) => f.path === path ? { ...f, dirty } : f));
      return path;
    });
  }, []);

  const handleResizeLeft = useCallback((delta: number) => {
    setLeftWidth((w) => Math.min(MAX_LEFT, Math.max(MIN_LEFT, w + delta)));
  }, []);

  const handleResizeRight = useCallback((delta: number) => {
    setRightWidth((w) => Math.min(MAX_RIGHT, Math.max(MIN_RIGHT, w + delta)));
  }, []);

  useEffect(() => {
    if (!saveError) return;
    const t = setTimeout(() => setSaveError(null), 3000);
    return () => clearTimeout(t);
  }, [saveError]);

  return (
    <div className="editor-page">
      {/* Left: file browser */}
      <div className="editor-left" style={{ width: leftWidth, minWidth: leftWidth }}>
        <FileBrowser
          rootPath={activeCwd ?? null}
          compact
          onFileSelect={handleFileSelect}
        />
      </div>

      <ResizeHandle side="left" onResize={handleResizeLeft} />

      {/* Center: tabs + CodeMirror */}
      <div className="editor-center">
        <div className="rp-tabs editor-tabs">
          {openFiles.map((f) => (
            <div key={f.path} className={`rp-tab${f.path === activePath ? " rp-tab--active" : ""}${f.dirty ? " rp-tab--dirty" : ""}`}>
              <button className="rp-tab-label" onClick={() => setActivePath(f.path)} title={f.path}>
                {f.dirty && <span className="editor-tab-dot" />}
                {basename(f.path)}
              </button>
              <button className="rp-tab-close" onClick={() => handleClose(f.path)} title="Close">
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
          <div className="editor-tabs-spacer" />
          {saving && <span className="editor-status editor-status--saving">saving…</span>}
          {saveError && <span className="editor-status editor-status--error">{saveError}</span>}
          {/* Git toggle */}
          {activeFile && (
            <button
              className={`editor-git-toggle${showGit ? " editor-git-toggle--on" : ""}`}
              onClick={() => setShowGit((v) => !v)}
              title={showGit ? "Hide git info" : "Show git info"}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <circle cx="3" cy="3" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <circle cx="3" cy="9" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <circle cx="9" cy="4" r="1.8" stroke="currentColor" strokeWidth="1.1"/>
                <path d="M3 4.8V7.2M3 4.8C4.5 4.8 7.2 4.2 7.2 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>

        <div className="editor-content">
          {activeFile ? (
            <CodeMirrorEditor
              key={activeFile.path}
              content={activeFile.content}
              path={activeFile.path}
              onSave={handleSave}
              onDirty={handleDirty}
            />
          ) : (
            <div className="editor-empty">select a file to edit</div>
          )}
        </div>
      </div>

      {/* Right: git info */}
      {activeFile && showGit && activeCwd && (
        <>
          <ResizeHandle side="right" onResize={handleResizeRight} />
          <div className="editor-right" style={{ width: rightWidth, minWidth: rightWidth }}>
            <GitFilePanel cwd={activeCwd} filePath={activeFile.path} />
          </div>
        </>
      )}
    </div>
  );
}
