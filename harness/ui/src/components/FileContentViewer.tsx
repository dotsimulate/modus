import { memo } from "react";
import type { PointerEventHandler, ReactNode } from "react";
import { Markdown } from "./Markdown";
import { CodeMirrorViewer } from "./CodeMirrorViewer";

type Props = {
  filePath: string;
  content: string | null;
  loading: boolean;
  error?: string | null;
  actions?: ReactNode;
  nameActions?: ReactNode;
  onHeaderPointerDown?: PointerEventHandler<HTMLDivElement>;
};

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

export const FileContentViewer = memo(function FileContentViewer({
  filePath,
  content,
  loading,
  error,
  actions,
  nameActions,
  onHeaderPointerDown,
}: Props) {
  const name = basename(filePath);
  const isMarkdown = /\.mdx?$/i.test(filePath);

  return (
    <div className="fcv-panel">
      <div className={`fcv-head${onHeaderPointerDown ? " fcv-head--draggable" : ""}`} onPointerDown={onHeaderPointerDown}>
        <div className="fcv-meta">
          <div className="fcv-name-row">
            <span className="fcv-name">{name}</span>
            {nameActions && <div className="fcv-name-actions">{nameActions}</div>}
          </div>
        </div>
        <div className="fcv-head-side">
          {actions && <div className="fcv-actions">{actions}</div>}
        </div>
      </div>
      <div className="fcv-body">
        {loading && <div className="fcv-state">Loading file...</div>}
        {!loading && error && <div className="fcv-state">{error}</div>}
        {!loading && !error && content === null && (
          <div className="fcv-state">File could not be read.</div>
        )}
        {!loading && !error && content !== null && isMarkdown && (
          <div className="message-content fcv-markdown">
            <Markdown content={content} />
          </div>
        )}
        {!loading && !error && content !== null && !isMarkdown && (
          <CodeMirrorViewer content={content} path={filePath} />
        )}
      </div>
    </div>
  );
});
