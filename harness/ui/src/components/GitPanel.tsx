import { useState, useEffect, useCallback } from "react";
import { fetchGitStatus, fetchGitLog, fetchGitShow } from "../api";
import type { GitStatus, GitCommit, GitCommitDetail, FileDiff, DiffHunk, DiffLine } from "../api";

// ── Pure helpers ──

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

// ── Diff Components ──

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

function FileDiffCard({ file }: { file: FileDiff }) {
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

function DiffView({ files }: { files: FileDiff[] }) {
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

// ── Status Components ──

function GitHeader({ status, cwd }: { status: GitStatus; cwd: string }) {
  const fileCount = (status.files?.modified.length ?? 0)
    + (status.files?.staged.length ?? 0)
    + (status.files?.untracked.length ?? 0);

  return (
    <div className="git-header">
      <div className="git-branch">
        <span className="git-branch-icon">⎇</span>
        <span className="git-branch-name">{status.branch}</span>
        {fileCount > 0 && <span className="git-dirty">●</span>}
        {(status.ahead ?? 0) > 0 && <span className="git-ahead">↑{status.ahead}</span>}
        {(status.behind ?? 0) > 0 && <span className="git-behind">↓{status.behind}</span>}
      </div>
      <span className="git-cwd">{cwd}</span>
    </div>
  );
}

function FileGroup({ label, files, variant }: { label: string; files: string[]; variant: string }) {
  if (files.length === 0) return null;
  return (
    <div className="git-file-group">
      <span className={`git-file-label ${variant}`}>{label}</span>
      {files.map((f) => (
        <span key={f} className={`git-file ${variant}`}>{f}</span>
      ))}
    </div>
  );
}

function FileStatus({ files }: { files: GitStatus["files"] }) {
  if (!files) return null;
  const count = files.modified.length + files.staged.length + files.untracked.length;
  if (count === 0) return null;
  return (
    <div className="git-files">
      <FileGroup label="staged" files={files.staged} variant="staged" />
      <FileGroup label="modified" files={files.modified} variant="modified" />
      <FileGroup label="untracked" files={files.untracked} variant="untracked" />
    </div>
  );
}

// ── Commit Components ──

function CommitList({ commits, selectedHash, onSelect }: {
  commits: GitCommit[];
  selectedHash: string | null;
  onSelect: (hash: string | null) => void;
}) {
  return (
    <div className="git-log">
      {commits.map((c) => (
        <button
          key={c.hash}
          className={`git-commit${selectedHash === c.hash ? " selected" : ""}`}
          onClick={() => onSelect(selectedHash === c.hash ? null : c.hash)}
        >
          <span className="git-commit-hash">{shortHash(c.hash)}</span>
          <span className="git-commit-msg">{c.message}</span>
          <span className="git-commit-meta">
            <span className="git-commit-author">{c.author}</span>
            <span className="git-commit-time">{timeAgo(c.date)}</span>
          </span>
          {(c.filesChanged || c.additions || c.deletions) && (
            <span className="git-commit-stats">
              {c.filesChanged && (
                <span className="git-commit-files">{c.filesChanged} file{c.filesChanged !== 1 ? "s" : ""}</span>
              )}
              {(c.additions ?? 0) > 0 && (
                <span className="diff-stat diff-stat--add">+{c.additions}</span>
              )}
              {(c.deletions ?? 0) > 0 && (
                <span className="diff-stat diff-stat--del">-{c.deletions}</span>
              )}
            </span>
          )}
        </button>
      ))}
      {commits.length === 0 && <div className="git-empty">No commits</div>}
    </div>
  );
}

function CommitDetail({ detail, loading }: {
  detail: GitCommitDetail | null;
  loading: boolean;
}) {
  if (loading) return <div className="git-detail"><div className="git-empty">Loading diff...</div></div>;
  if (!detail) return <div className="git-detail"><div className="git-empty">Could not load commit</div></div>;

  const totalAdd = detail.files.reduce((s, f) => s + f.additions, 0);
  const totalDel = detail.files.reduce((s, f) => s + f.deletions, 0);

  return (
    <div className="git-detail">
      <div className="git-detail-header">
        <span className="git-detail-hash">{shortHash(detail.hash)}</span>
        <span className="git-detail-msg">{detail.message}</span>
        <span className="git-detail-meta">
          {detail.author} · {timeAgo(detail.date)}
          <span className="git-detail-summary">
            {detail.files.length} file{detail.files.length !== 1 ? "s" : ""}
            {totalAdd > 0 && <span className="diff-stat diff-stat--add"> +{totalAdd}</span>}
            {totalDel > 0 && <span className="diff-stat diff-stat--del"> -{totalDel}</span>}
          </span>
        </span>
      </div>
      <DiffView files={detail.files} />
    </div>
  );
}

function NoSelectionView({ commits, status }: { commits: GitCommit[]; status: GitStatus }) {
  const totalAdd = commits.reduce((s, c) => s + (c.additions ?? 0), 0);
  const totalDel = commits.reduce((s, c) => s + (c.deletions ?? 0), 0);
  const totalFiles = commits.reduce((s, c) => s + (c.filesChanged ?? 0), 0);
  const authors = [...new Set(commits.map((c) => c.author))];
  const dirtyCount = (status.files?.modified.length ?? 0)
    + (status.files?.staged.length ?? 0)
    + (status.files?.untracked.length ?? 0);

  return (
    <div className="git-overview">
      <div className="git-overview-section">
        <span className="git-overview-label">recent activity</span>
        <span className="git-overview-headline">
          {commits.length} commit{commits.length !== 1 ? "s" : ""}
        </span>
        <div className="git-overview-stats">
          <span className="git-overview-stat">
            <span className="git-overview-num">{totalFiles}</span> files touched
          </span>
          <span className="git-overview-stat">
            <span className="diff-stat diff-stat--add">+{totalAdd}</span>
            <span className="diff-stat diff-stat--del">-{totalDel}</span>
          </span>
        </div>
      </div>

      {dirtyCount > 0 && (
        <div className="git-overview-section">
          <span className="git-overview-label">working tree</span>
          <span className="git-overview-headline">
            {dirtyCount} uncommitted change{dirtyCount !== 1 ? "s" : ""}
          </span>
          <div className="git-overview-dirty">
            {(status.files?.staged.length ?? 0) > 0 && (
              <span className="git-overview-file-count staged">
                {status.files!.staged.length} staged
              </span>
            )}
            {(status.files?.modified.length ?? 0) > 0 && (
              <span className="git-overview-file-count modified">
                {status.files!.modified.length} modified
              </span>
            )}
            {(status.files?.untracked.length ?? 0) > 0 && (
              <span className="git-overview-file-count untracked">
                {status.files!.untracked.length} untracked
              </span>
            )}
          </div>
        </div>
      )}

      <div className="git-overview-section">
        <span className="git-overview-label">contributors</span>
        <div className="git-overview-authors">
          {authors.map((a) => (
            <span key={a} className="git-overview-author">{a}</span>
          ))}
        </div>
      </div>

      <div className="git-overview-hint">select a commit to view diff</div>
    </div>
  );
}

// ── Main export ──

export function GitPanel({ cwd }: { cwd: string | null }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const load = useCallback(async () => {
    if (!cwd) return;
    try {
      const [s, l] = await Promise.all([
        fetchGitStatus(cwd),
        fetchGitLog(cwd),
      ]);
      setStatus(s);
      setLog(l);
    } catch { /* silent */ }
  }, [cwd]);

  // Initial load + poll every 10s
  useEffect(() => {
    setStatus(null);
    setLog([]);
    setSelectedHash(null);
    setDetail(null);
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  // Load commit detail on selection
  useEffect(() => {
    if (!selectedHash || !cwd) { setDetail(null); return; }
    let active = true;
    setLoadingDetail(true);
    fetchGitShow(cwd, selectedHash)
      .then((d) => { if (active) setDetail(d); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setLoadingDetail(false); });
    return () => { active = false; };
  }, [selectedHash, cwd]);

  if (!cwd) {
    return (
      <div className="git-panel">
        <div className="git-empty">No working directory selected</div>
      </div>
    );
  }

  if (status === null) {
    return (
      <div className="git-panel">
        <div className="git-empty">Loading...</div>
      </div>
    );
  }

  if (!status.git) {
    return (
      <div className="git-panel">
        <div className="git-empty">
          <span className="git-empty-path">{cwd}</span> is not a git repository
        </div>
      </div>
    );
  }

  return (
    <div className="git-panel">
      <GitHeader status={status} cwd={cwd} />
      <FileStatus files={status.files} />
      <div className="git-body">
        <CommitList
          commits={log}
          selectedHash={selectedHash}
          onSelect={setSelectedHash}
        />
        {selectedHash ? (
          <CommitDetail detail={detail} loading={loadingDetail} />
        ) : (
          <NoSelectionView commits={log} status={status} />
        )}
      </div>
    </div>
  );
}
