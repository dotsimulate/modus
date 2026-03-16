/**
 * CodeMirrorViewer — read-only syntax-highlighted code surface.
 *
 * Same theme and language detection as CodeMirrorEditor, but non-editable.
 * Used by FileContentViewer for code files in view mode.
 */

import { useRef, useEffect } from "react";
import { EditorView, lineNumbers, drawSelection } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { langFromPath, moTheme } from "./codemirror-shared";

export function CodeMirrorViewer({ content, path }: { content: string; path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: content,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        lineNumbers(),
        drawSelection(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        langFromPath(path),
        moTheme,
        EditorView.lineWrapping,
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    return () => { view.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, content]);

  return <div ref={containerRef} className="cm-editor-container" />;
}
