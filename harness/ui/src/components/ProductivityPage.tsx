/**
 * ProductivityPage — split-layout file browser + content viewer + quick notes.
 *
 * Left: file browser (directory navigation + file list)
 * Right: file content preview or notes quick-access
 *
 * Future: CodeMirror 6 integration for in-browser editing.
 */

import { useState, useCallback } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { FileBrowser } from "./FileBrowser";
import { FileContentViewer } from "./FileContentViewer";
import { NotesEditor } from "./NotesEditor";
import { readFileContent, openInEditor } from "../api";

type RightPane = "file" | "notes";

export function ProductivityPage() {
  const { activeCwd } = useProfiles();
  const [rightPane, setRightPane] = useState<RightPane>("notes");
  const [filePreview, setFilePreview] = useState<{ path: string; content: string } | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const handleFileSelect = useCallback(async (path: string) => {
    setRightPane("file");
    setFileLoading(true);
    try {
      const content = await readFileContent(path);
      setFilePreview({ path, content: content ?? "Could not read file." });
    } catch {
      setFilePreview({ path, content: "Could not read file." });
    }
    setFileLoading(false);
  }, []);

  const handleCloseFile = useCallback(() => {
    setFilePreview(null);
    setRightPane("notes");
  }, []);

  return (
    <div className="prod-page">
      <div className="prod-page-inner">
        {/* Tab bar */}
        <div className="prod-tabs">
          <button
            className={`prod-tab${rightPane === "notes" ? " active" : ""}`}
            onClick={() => setRightPane("notes")}
          >
            notes
          </button>
          <button
            className={`prod-tab${rightPane === "file" ? " active" : ""}`}
            onClick={() => setRightPane("file")}
          >
            viewer
          </button>
          <div className="prod-tabs-spacer" />
          {activeCwd && (
            <span className="prod-tabs-path">{activeCwd}</span>
          )}
        </div>

        <div className="prod-split">
          {/* Left: File browser */}
          <div className="prod-left">
            <FileBrowser
              rootPath={activeCwd ?? null}
              onFileSelect={handleFileSelect}
            />
          </div>

          {/* Right: Notes or File preview */}
          <div className="prod-right">
            {rightPane === "notes" && (
              <NotesEditor cwd={activeCwd ?? null} />
            )}
            {rightPane === "file" && filePreview && (
              <div className="prod-file-preview">
                <FileContentViewer
                  filePath={filePreview.path}
                  content={filePreview.content}
                  loading={fileLoading}
                  actions={
                    <>
                      <button
                        className="fb-btn"
                        onClick={() => openInEditor(filePreview.path)}
                        title="Open in editor"
                      >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                          <path d="M10 6.5V10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h3.5M7 1h4v4M5 7l6-6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      <button
                        className="fb-btn"
                        onClick={handleCloseFile}
                        title="Close preview"
                      >
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                        </svg>
                      </button>
                    </>
                  }
                />
              </div>
            )}
            {rightPane === "file" && !filePreview && (
              <div className="prod-empty">select a file to preview</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
