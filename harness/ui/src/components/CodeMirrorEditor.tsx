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
import { indentOnInput, bracketMatching, syntaxHighlighting, foldGutter, foldKeymap } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { langFromPath, moTheme, moHighlightStyle } from "./codemirror-shared";

export type CodeMirrorContextInfo = {
  selection: string;
  line: number;
  path: string;
};

// ── Component ──

export function CodeMirrorEditor({
  content, path, revealLine, revealEndLine, revealToken, onSave, onDirty, onEditorContextMenu,
}: {
  content: string;
  path: string;
  revealLine?: number;
  revealEndLine?: number;
  revealToken?: number;
  onSave: (content: string) => void;
  onDirty: (dirty: boolean) => void;
  onEditorContextMenu?: (e: React.MouseEvent, info: CodeMirrorContextInfo) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onDirtyRef = useRef(onDirty);
  const onCtxRef = useRef(onEditorContextMenu);
  onSaveRef.current = onSave;
  onDirtyRef.current = onDirty;
  onCtxRef.current = onEditorContextMenu;

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
        closeBrackets(),
        syntaxHighlighting(moHighlightStyle, { fallback: true }),
        search({ top: true }),
        highlightSelectionMatches(),
        foldGutter(),
        autocompletion(),
        keymap.of([
          { key: "Mod-s", run(view) { onSaveRef.current(view.state.doc.toString()); return true; } },
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...foldKeymap,
          ...completionKeymap,
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

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !revealLine) return;
    const startLine = Math.max(1, Math.min(revealLine, view.state.doc.lines));
    const endLine = Math.max(startLine, Math.min(revealEndLine ?? startLine, view.state.doc.lines));
    const from = view.state.doc.line(startLine).from;
    const to = view.state.doc.line(endLine).to;
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
    view.focus();
  }, [revealEndLine, revealLine, revealToken]);

  const handleContextMenu = (e: React.MouseEvent) => {
    const view = viewRef.current;
    if (!view || !onCtxRef.current) return;
    const sel = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    );
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    onCtxRef.current(e, { selection: sel, line, path });
  };

  return <div ref={containerRef} className="cm-editor-container" onContextMenu={handleContextMenu} />;
}
