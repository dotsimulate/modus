import { memo, useMemo } from "react";
import type { CSSProperties } from "react";
import type { PointerEventHandler, ReactNode } from "react";
import { Markdown } from "./Markdown";

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
  const lines = useMemo(() => (content ?? "").split("\n"), [content]);
  const lineNumberDigits = Math.max(2, String(lines.length || 1).length);
  const isMarkdown = /\.mdx?$/i.test(filePath);

  return (
    <div
      className="fcv-panel"
      style={{ "--fcv-gutter-chars": lineNumberDigits } as CSSProperties}
    >
      <div className={`fcv-head${onHeaderPointerDown ? " fcv-head--draggable" : ""}`} onPointerDown={onHeaderPointerDown}>
        <div className="fcv-meta">
          <div className="fcv-name-row">
            <span className="fcv-name">{name}</span>
            {nameActions && <div className="fcv-name-actions">{nameActions}</div>}
          </div>
        </div>
        <div className="fcv-head-side">
          {!loading && !error && content !== null && (
            <span className="fcv-count">
              {lines.length} line{lines.length === 1 ? "" : "s"}
            </span>
          )}
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
          <table className="diff-table fcv-table">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="diff-line diff-line--ctx">
                  <td className="diff-gutter">{i + 1}</td>
                  <td className="diff-code">
                    <span>{line}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});
