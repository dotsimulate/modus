/**
 * Shared CodeMirror setup — theme and language detection.
 *
 * Used by both CodeMirrorEditor (read-write) and CodeMirrorViewer (read-only)
 * so both surfaces stay visually identical.
 */

import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
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

// ── Syntax highlighting using --syn-* CSS variables ──

export const moHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.standard(t.name), t.bool, t.null], color: "var(--syn-builtin)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.literal, t.atom], color: "var(--syn-literal)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syn-number)" },
  { tag: [t.string, t.character, t.special(t.string)], color: "var(--syn-string)" },
  { tag: t.regexp, color: "var(--syn-regexp)" },
  { tag: [t.self, t.processingInstruction], color: "var(--syn-symbol)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.variableName, t.propertyName], color: "var(--syn-variable)" },
  { tag: [t.tagName], color: "var(--syn-tag)" },
  { tag: [t.attributeName], color: "var(--syn-attr)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--syn-function)" },
  { tag: t.operator, color: "var(--syn-keyword)" },
  { tag: t.punctuation, color: "var(--syn-variable)" },
]);

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
    background: "var(--bg)",
    borderRight: "none",
    color: "var(--text-muted)",
  },
  ".cm-activeLineGutter": { background: "transparent", color: "var(--text-tertiary)" },
  ".cm-activeLine": { background: "rgba(255,255,255,0.025)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 6px", textAlign: "right" },
  ".cm-scroller": { overflow: "auto" },
  "&.cm-focused .cm-matchingBracket": {
    background: "rgba(255,255,255,0.08)",
    outline: "1px solid rgba(255,255,255,0.14)",
    borderRadius: "2px",
  },
  "&.cm-focused .cm-nonmatchingBracket": {
    background: "rgba(255,51,51,0.16)",
    outline: "1px solid rgba(255,51,51,0.28)",
    borderRadius: "2px",
  },

  // Search panel — compact, right-aligned, floating
  ".cm-panels": {
    background: "transparent",
    border: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    position: "relative",
  },
  ".cm-panels.cm-panels-top": {
    borderBottom: "none",
  },
  ".cm-panel.cm-search": {
    position: "absolute",
    top: "4px",
    right: "16px",
    zIndex: "10",
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    borderRadius: "3px",
    padding: "4px 20px 4px 5px",
    display: "inline-flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    width: "auto",
  },
  ".cm-panel.cm-search br": { display: "block", flexBasis: "100%", height: "4px" },
  ".cm-panel.cm-search label": {
    color: "var(--text-muted)",
    fontSize: "10px",
    margin: "0",
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
    gap: "0",
    padding: "0 3px",
    height: "20px",
    borderRadius: "2px",
    cursor: "pointer",
    transition: "color 0.1s ease",
  },
  ".cm-panel.cm-search label:hover": { color: "var(--text-tertiary)" },
  ".cm-panel.cm-search input[type=checkbox]": {
    appearance: "none",
    width: "0",
    height: "0",
    margin: "0",
    padding: "0",
    position: "absolute",
    opacity: "0",
  },
  ".cm-panel.cm-search input[type=checkbox]:checked + *": {
    color: "var(--text-secondary)",
  },
  ".cm-panel.cm-search label:has(input:checked)": {
    color: "var(--text-secondary)",
    background: "rgba(255,255,255,0.06)",
  },
  ".cm-panel.cm-search [name=close]": {
    position: "absolute",
    top: "3px",
    right: "4px",
    color: "var(--text-muted)",
    fontSize: "13px",
    lineHeight: "1",
    cursor: "pointer",
    width: "14px",
    height: "14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0",
    margin: "0",
    background: "none",
    border: "none",
  },
  ".cm-panel.cm-search [name=close]:hover": { color: "var(--text)" },
  ".cm-textfield": {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    color: "var(--text)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    borderRadius: "2px",
    padding: "1px 5px",
    margin: "0 3px 0 0",
    outline: "none",
    height: "20px",
    boxSizing: "border-box",
    width: "110px",
  },
  ".cm-textfield:focus": { borderColor: "var(--border-active)" },
  ".cm-button": {
    background: "none",
    border: "none",
    color: "var(--text-muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    borderRadius: "2px",
    padding: "1px 4px",
    margin: "0 1px",
    cursor: "pointer",
    height: "20px",
    boxSizing: "border-box",
    lineHeight: "1",
  },
  ".cm-button:hover": { color: "var(--text-secondary)", background: "rgba(255,255,255,0.04)" },

  // Search match highlighting
  ".cm-searchMatch": { background: "rgba(255, 255, 255, 0.08)", outline: "1px solid rgba(255,255,255,0.12)" },
  ".cm-searchMatch.cm-searchMatch-selected": { background: "rgba(232, 155, 80, 0.25)" },

  // Selection match highlighting
  ".cm-selectionMatch": { background: "rgba(255, 255, 255, 0.06)" },

  // Fold gutter
  ".cm-foldGutter .cm-gutterElement": {
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "0 4px 0 0",
    fontSize: "12px",
    transition: "color 0.1s ease",
  },
  ".cm-foldGutter .cm-gutterElement:hover": { color: "var(--text-tertiary)" },
  ".cm-foldPlaceholder": {
    background: "var(--bg-surface)",
    border: "1px solid var(--border)",
    color: "var(--text-muted)",
    padding: "0 4px",
    borderRadius: "2px",
    cursor: "pointer",
    fontSize: "11px",
  },

  // Autocomplete tooltip
  ".cm-tooltip": {
    background: "var(--bg-raised)",
    border: "1px solid var(--border)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
  },
  ".cm-tooltip-autocomplete": { fontFamily: "var(--font-mono)", fontSize: "12px" },
  ".cm-tooltip-autocomplete ul li": {
    padding: "3px 8px",
    color: "var(--text-secondary)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--bg-hover)",
    color: "var(--text)",
  },
  ".cm-completionLabel": { color: "var(--text-secondary)" },
  ".cm-completionMatchedText": { color: "var(--syn-function)", textDecoration: "none" },
}, { dark: true });
