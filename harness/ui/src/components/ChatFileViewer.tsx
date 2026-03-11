import { useEffect, useState } from "react";
import { openInEditor, readFileContent } from "../api";
import { FileContentViewer } from "./FileContentViewer";
import { FloatingWindow } from "./FloatingWindow";

type Props = {
  filePath: string | null;
  onClose: () => void;
};

export function ChatFileViewer({ filePath, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState(false);

  useEffect(() => {
    if (!filePath) return;
    let active = true;
    setLoading(true);
    setError(null);
    setContent(null);

    readFileContent(filePath)
      .then((text) => { if (active) setContent(text); })
      .catch(() => { if (active) setError("Could not load file contents."); })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    setCopiedPath(false);
  }, [filePath]);

  useEffect(() => {
    if (!copiedPath) return;
    const timer = window.setTimeout(() => setCopiedPath(false), 1000);
    return () => window.clearTimeout(timer);
  }, [copiedPath]);

  return (
    <FloatingWindow
      open={!!filePath}
      onClose={onClose}
      storageKey="chat-file-viewer-bounds"
      className="chat-file-viewer-popup"
    >
      {({ onPointerDown }) => (
        <FileContentViewer
          filePath={filePath!}
          content={content}
          loading={loading}
          error={error}
          onHeaderPointerDown={onPointerDown}
          nameActions={
            <button
              className={`chat-file-viewer-btn chat-file-viewer-btn--inline${copiedPath ? " is-copied" : ""}`}
              onClick={() => {
                navigator.clipboard.writeText(filePath!).then(() => setCopiedPath(true)).catch(() => {});
              }}
              title={copiedPath ? "Copied full path" : "Copy full file path"}
              aria-label={copiedPath ? "Copied full file path" : "Copy full file path"}
            >
              {copiedPath ? (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M2.2 6.4 4.6 8.8 9.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                </svg>
              )}
            </button>
          }
          actions={
            <>
              <button
                className="chat-file-viewer-btn"
                onClick={() => openInEditor(filePath!)}
                title="Open in editor"
                aria-label="Open in editor"
              >
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                  <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button className="chat-file-viewer-btn" onClick={onClose} title="Close" aria-label="Close">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </>
          }
        />
      )}
    </FloatingWindow>
  );
}
