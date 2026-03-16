/**
 * CodeMirrorEditor — reusable editable text surface.
 *
 * Wraps CodeMirror 6 with MO theming, language detection, and Ctrl+S save.
 * This is a content renderer — it knows nothing about tabs, files, or panels.
 */

import { useRef, useEffect } from "react";
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

// ── Component ──

export function CodeMirrorEditor({
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

  return <div ref={containerRef} className="cm-editor-container" />;
}
