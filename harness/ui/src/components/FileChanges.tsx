import { memo, useState } from "react";
import type { ToolCall } from "../api";
import { openInEditor } from "../api";
import { API_BASE, tokenParam } from "../api/_fetch";

type FileEdit = {
  filePath: string;
  type: "edit" | "write";
  oldString?: string;
  newString?: string;
  content?: string;
};

/** Extract file edits from an array of tool calls (recurses into sub-agents) */
export function extractFileEdits(toolCalls: ToolCall[]): FileEdit[] {
  const edits: FileEdit[] = [];

  for (const tc of toolCalls) {
    if (tc.status !== "completed") continue;

    if (tc.name === "Edit" || tc.name === "MultiEdit") {
      const fp = tc.input.file_path as string | undefined;
      if (!fp) continue;

      if (tc.name === "MultiEdit" && Array.isArray(tc.input.edits)) {
        for (const edit of tc.input.edits as Array<{ old_string?: string; new_string?: string }>) {
          edits.push({
            filePath: fp,
            type: "edit",
            oldString: edit.old_string ?? "",
            newString: edit.new_string ?? "",
          });
        }
      } else {
        edits.push({
          filePath: fp,
          type: "edit",
          oldString: tc.input.old_string as string ?? "",
          newString: tc.input.new_string as string ?? "",
        });
      }
    } else if (tc.name === "Write") {
      const fp = tc.input.file_path as string | undefined;
      if (!fp) continue;
      edits.push({
        filePath: fp,
        type: "write",
        content: tc.input.content as string ?? "",
      });
    }

    // Recurse into sub-agent messages
    if (tc.subMessages) {
      for (const sub of tc.subMessages) {
        if (sub.toolCalls) {
          edits.push(...extractFileEdits(sub.toolCalls));
        }
      }
    }
  }

  return edits;
}

/** Group edits by file path */
function groupByFile(edits: FileEdit[]): Map<string, FileEdit[]> {
  const map = new Map<string, FileEdit[]>();
  for (const edit of edits) {
    const list = map.get(edit.filePath) ?? [];
    list.push(edit);
    map.set(edit.filePath, list);
  }
  return map;
}

/** Count additions and deletions from edit strings */
function countChanges(edits: FileEdit[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === "write") {
      additions += (edit.content ?? "").split("\n").length;
    } else {
      const oldLines = (edit.oldString ?? "").split("\n").filter(Boolean).length;
      const newLines = (edit.newString ?? "").split("\n").filter(Boolean).length;
      additions += newLines;
      deletions += oldLines;
    }
  }
  return { additions, deletions };
}

function shortPath(p: string): string {
  return p
    .replace(/^\/home\/[^/]+\//, "~/")
    .replace(/^[A-Z]:\\Users\\[^\\]+\\/, "~/")
    .replace(/\\/g, "/");
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

/** Render a single edit as a table hunk — reuses git diff CSS */
function EditHunk({ edit, idx }: { edit: FileEdit; idx: number }) {
  if (edit.type === "write") {
    const lines = (edit.content ?? "").split("\n");
    const show = lines.slice(0, 30);
    return (
      <tbody className="diff-hunk-block">
        <tr className="diff-hunk-header">
          <td className="diff-gutter" colSpan={3}></td>
          <td className="diff-hunk-range">file written</td>
        </tr>
        {show.map((l, i) => (
          <tr key={i} className="diff-line diff-line--add">
            <td className="diff-gutter diff-gutter--old"></td>
            <td className="diff-gutter diff-gutter--new">{i + 1}</td>
            <td className="diff-gutter diff-gutter--marker">+</td>
            <td className="diff-code"><span>{l}</span></td>
          </tr>
        ))}
        {lines.length > 30 && (
          <tr className="diff-hunk-header">
            <td className="diff-gutter" colSpan={3}></td>
            <td className="diff-hunk-range">… {lines.length - 30} more lines</td>
          </tr>
        )}
      </tbody>
    );
  }

  const ol = (edit.oldString ?? "").split("\n");
  const nl = (edit.newString ?? "").split("\n");

  return (
    <tbody className="diff-hunk-block">
      {idx > 0 && (
        <tr className="diff-hunk-header">
          <td className="diff-gutter" colSpan={3}></td>
          <td className="diff-hunk-range"></td>
        </tr>
      )}
      {ol.map((l, i) => (
        <tr key={`d${i}`} className="diff-line diff-line--del">
          <td className="diff-gutter diff-gutter--old">{i + 1}</td>
          <td className="diff-gutter diff-gutter--new"></td>
          <td className="diff-gutter diff-gutter--marker">-</td>
          <td className="diff-code"><span>{l}</span></td>
        </tr>
      ))}
      {nl.map((l, i) => (
        <tr key={`a${i}`} className="diff-line diff-line--add">
          <td className="diff-gutter diff-gutter--old"></td>
          <td className="diff-gutter diff-gutter--new">{i + 1}</td>
          <td className="diff-gutter diff-gutter--marker">+</td>
          <td className="diff-code"><span>{l}</span></td>
        </tr>
      ))}
    </tbody>
  );
}

const BROWSER_EXTS = new Set([
  ".html", ".htm", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
]);

function isBrowserPreviewable(filePath: string): boolean {
  const ext = filePath.replace(/\\/g, "/").split("/").pop()?.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  return !!ext && BROWSER_EXTS.has(ext);
}

function rawFileUrl(filePath: string): string {
  const tp = tokenParam();
  const sep = tp ? "&" : "";
  return `${API_BASE}/api/file/raw?path=${encodeURIComponent(filePath)}${sep}${tp}`;
}

/** A single file card with collapsible edits */
function FileCard({ filePath, edits }: { filePath: string; edits: FileEdit[] }) {
  const [expanded, setExpanded] = useState(false);
  const { additions, deletions } = countChanges(edits);
  const name = basename(filePath);
  const dir = shortPath(filePath).replace(/\/?[^/]+$/, "");
  const previewable = isBrowserPreviewable(filePath);

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    openInEditor(filePath);
  };

  const handlePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.open(rawFileUrl(filePath), "_blank");
  };

  return (
    <div className="fc-file">
      <div className="fc-file-header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-file-toggle">{expanded ? "v" : ">"}</span>
        <span className="fc-file-name">{name}</span>
        <span className="fc-file-dir">{dir}</span>
        <span className="fc-file-stats">
          {additions > 0 && <span className="diff-stat diff-stat--add">+{additions}</span>}
          {deletions > 0 && <span className="diff-stat diff-stat--del">-{deletions}</span>}
        </span>
        {previewable && (
          <button className="fc-open-btn" onClick={handlePreview} title="Open in browser">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
              <ellipse cx="6" cy="6" rx="2.2" ry="5" stroke="currentColor" strokeWidth="1.2"/>
              <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/>
            </svg>
          </button>
        )}
        <button className="fc-open-btn" onClick={handleOpen} title="Open in editor">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M10 6.5V10a1 1 0 01-1 1H2a1 1 0 01-1-1V3a1 1 0 011-1h3.5M7 1h4v4M5 7l6-6"
              stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="fc-file-body">
          <table className="diff-table">
            {edits.map((edit, i) => (
              <EditHunk key={i} edit={edit} idx={i} />
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

type Props = {
  toolCalls: ToolCall[];
};

export const FileChanges = memo(function FileChanges({ toolCalls }: Props) {
  const edits = extractFileEdits(toolCalls);
  if (edits.length === 0) return null;

  const grouped = groupByFile(edits);
  const totalChanges = countChanges(edits);
  const fileCount = grouped.size;

  return (
    <div className="fc-container">
      <div className="fc-container-inner">
        <div className="fc-header">
          <span className="fc-header-label">
            {fileCount} file{fileCount !== 1 ? "s" : ""} changed
          </span>
          <span className="fc-header-stats">
            {totalChanges.additions > 0 && (
              <span className="diff-stat diff-stat--add">+{totalChanges.additions}</span>
            )}
            {totalChanges.deletions > 0 && (
              <span className="diff-stat diff-stat--del">-{totalChanges.deletions}</span>
            )}
          </span>
        </div>
        <div className="fc-files">
          {[...grouped.entries()].map(([fp, edits]) => (
            <FileCard key={fp} filePath={fp} edits={edits} />
          ))}
        </div>
      </div>
    </div>
  );
});
