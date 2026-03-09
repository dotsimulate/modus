import { useState } from "react";
import type { FileDiff, DiffHunk, DiffLine } from "../api";

function DiffLineRow({ line }: { line: DiffLine }) {
  return (
    <tr className={`diff-line diff-line--${line.type}`}>
      <td className="diff-gutter diff-gutter--old">
        {line.oldNum ?? ""}
      </td>
      <td className="diff-gutter diff-gutter--new">
        {line.newNum ?? ""}
      </td>
      <td className="diff-gutter diff-gutter--marker">
        {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
      </td>
      <td className="diff-code">
        <span>{line.content}</span>
      </td>
    </tr>
  );
}

function HunkView({ hunk }: { hunk: DiffHunk }) {
  return (
    <tbody className="diff-hunk-block">
      <tr className="diff-hunk-header">
        <td className="diff-gutter" colSpan={3}></td>
        <td className="diff-hunk-range">{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}
    </tbody>
  );
}

export function FileDiffCard({ file }: { file: FileDiff }) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div className="diff-file">
      <button
        className="diff-file-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="diff-file-toggle">{collapsed ? ">" : "v"}</span>
        <span className="diff-file-path">{file.path}</span>
        <span className="diff-file-stats">
          {file.additions > 0 && (
            <span className="diff-stat diff-stat--add">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="diff-stat diff-stat--del">-{file.deletions}</span>
          )}
        </span>
      </button>
      {!collapsed && (
        <div className="diff-file-body">
          <table className="diff-table">
            {file.hunks.map((hunk, i) => (
              <HunkView key={i} hunk={hunk} />
            ))}
          </table>
        </div>
      )}
    </div>
  );
}

export function DiffView({ files }: { files: FileDiff[] }) {
  if (files.length === 0) {
    return <div className="git-empty">No changes in this commit</div>;
  }
  return (
    <div className="diff-view">
      {files.map((file) => (
        <FileDiffCard key={file.path} file={file} />
      ))}
    </div>
  );
}
