/**
 * CodeMirrorViewer — read-only syntax-highlighted code surface.
 *
 * Same theme and language detection as CodeMirrorEditor, but non-editable.
 * Used by FileContentViewer for code files in view mode.
 */

import { useRef, useEffect } from "react";
import { EditorView, keymap, lineNumbers, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting, foldGutter, foldKeymap } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { langFromPath, moTheme, moHighlightStyle } from "./codemirror-shared";
import type { CodeMirrorContextInfo } from "./CodeMirrorEditor";

export function CodeMirrorViewer({
  content, path, revealLine, revealEndLine, revealToken, onEditorContextMenu,
}: {
  content: string;
  path: string;
  revealLine?: number;
  revealEndLine?: number;
  revealToken?: number;
  onEditorContextMenu?: (e: React.MouseEvent, info: CodeMirrorContextInfo) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onCtxRef = useRef(onEditorContextMenu);
  onCtxRef.current = onEditorContextMenu;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers(),
        drawSelection(),
        syntaxHighlighting(moHighlightStyle, { fallback: true }),
        search({ top: true }),
        highlightSelectionMatches(),
        foldGutter(),
        keymap.of([...searchKeymap, ...foldKeymap]),
        langFromPath(path),
        moTheme,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content]);

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
