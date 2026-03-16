/**
 * Shared CodeMirror setup — theme and language detection.
 *
 * Used by both CodeMirrorEditor (read-write) and CodeMirrorViewer (read-only)
 * so both surfaces stay visually identical.
 */

import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";

// ── Language detection ──

export function langFromPath(path: string) {
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

export const moTheme = EditorView.theme({
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
