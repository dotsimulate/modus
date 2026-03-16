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
import { langFromPath, moTheme } from "./codemirror-shared";

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
