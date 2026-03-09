import { useState, useEffect, useCallback } from "react";
import { fetchGitStatus, fetchGitLog, fetchGitShow, fetchGitFileDiff, fetchGitReadme, fetchGitFileContent } from "../api";
import type { GitStatus, GitCommit, GitCommitDetail, FileDiff } from "../api";
import { getAuthToken } from "../api/_fetch";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

// ── Helpers ──

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function shortHash(h: string) { return h.slice(0, 7); }
function changeVolume(c: GitCommit) { return (c.additions ?? 0) + (c.deletions ?? 0); }

/** First line of a possibly multi-line commit message */
function subject(msg: string) { return msg.split("\n")[0] ?? msg; }

/** Rewrite relative image paths to serve through the backend (with auth) */
function rewriteImagePaths(md: string, cwd: string): string {
  const base = `/api/git/raw/`;
  const token = getAuthToken();
  const params = `?cwd=${encodeURIComponent(cwd)}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  // HTML img tags: src="relative/path"
  md = md.replace(/(<img\s[^>]*?src=["'])(?!https?:\/\/|\/)(.*?)(["'])/gi,
    (_, pre, path, post) => `${pre}${base}${path}${params}${post}`);
  // Markdown images: ![alt](relative/path)
  md = md.replace(/(!\[[^\]]*\]\()(?!https?:\/\/|\/)([^)]+)(\))/g,
    (_, pre, path, post) => `${pre}${base}${path}${params}${post}`);
  return md;
}

/** Check if a file path is a pretty-renderable type */
function isPrettyFile(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".html") || lower.endsWith(".htm");
}

/** Chevron SVG — small, rotates */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`git-chevron${open ? " git-chevron--open" : ""}`} width="8" height="8" viewBox="0 0 8 8">
      <path d="M2.5 1.5L5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Detail pane states ──

type DetailState =
  | { kind: "overview" }
  | { kind: "wt-file"; file: string }
  | { kind: "commit"; hash: string }
  | { kind: "commit-file"; hash: string; file: string };

// ── Top bar ──

function TopBar({ status, cwd, commits, onClick }: {
  status: GitStatus; cwd: string; commits: GitCommit[]; onClick: () => void;
}) {
  const totalAdd = commits.reduce((s, c) => s + (c.additions ?? 0), 0);
  const totalDel = commits.reduce((s, c) => s + (c.deletions ?? 0), 0);
  const totalFiles = commits.reduce((s, c) => s + (c.filesChanged ?? 0), 0);
  const fileCount = (status.files?.modified.length ?? 0)
    + (status.files?.staged.length ?? 0)
    + (status.files?.untracked.length ?? 0);

  return (
    <button className="git-topbar" onClick={onClick} type="button">
      <div className="git-topbar-left">
        <div className="git-topbar-repo">
          {status.remote ? (
            <span className="git-repo-name">{status.remote}</span>
          ) : (
            <span className="git-repo-name git-repo-name--local">local</span>
          )}
          <span className="git-repo-path">{cwd}</span>
        </div>
        <div className="git-topbar-branch">
          <span className="git-branch-icon">⎇</span>
          <span className="git-branch-name">{status.branch}</span>
          {fileCount > 0 && <span className="git-dirty-dot" />}
          {(status.ahead ?? 0) > 0 && <span className="git-sync git-sync--ahead">↑{status.ahead}</span>}
          {(status.behind ?? 0) > 0 && <span className="git-sync git-sync--behind">↓{status.behind}</span>}
        </div>
      </div>
      <div className="git-topbar-stats">
        <div className="git-stat">
          <span className="git-stat-num">{commits.length}</span>
          <span className="git-stat-label">commits</span>
        </div>
        <div className="git-stat">
          <span className="git-stat-num">{totalFiles}</span>
          <span className="git-stat-label">files</span>
        </div>
        <div className="git-stat">
          <span className="git-stat-num git-stat-num--add">+{totalAdd}</span>
          <span className="git-stat-num git-stat-num--del">-{totalDel}</span>
        </div>
        {fileCount > 0 && (
          <div className="git-stat git-stat--dirty">
            <span className="git-stat-num">{fileCount}</span>
            <span className="git-stat-label">dirty</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ── Left Summary (working tree + contributors — compact) ──

function LeftSummary({ status, commits, onFileClick, activeFile }: {
  status: GitStatus; commits: GitCommit[];
  onFileClick: (f: string) => void; activeFile: string | null;
}) {
  const files = status.files;
  const dirtyCount = (files?.modified.length ?? 0) + (files?.staged.length ?? 0) + (files?.untracked.length ?? 0);
  const authors = [...new Set(commits.map((c) => c.author))];
  const [wtOpen, setWtOpen] = useState(() => {
    try { return localStorage.getItem("git-wt-open") !== "0"; } catch { return true; }
  });
  const toggleWt = () => {
    setWtOpen((prev) => { const next = !prev; try { localStorage.setItem("git-wt-open", next ? "1" : "0"); } catch {} return next; });
  };

  return (
    <div className="git-left-summary">
      {dirtyCount > 0 && files && (
        <div className="git-ls-wt">
          <button className="git-ls-wt-head" onClick={toggleWt} type="button">
            <Chevron open={wtOpen} />
            <span className="git-section-label">working tree</span>
            <span className="git-ls-wt-count">{dirtyCount} uncommitted</span>
          </button>
          <div className={`git-ls-wt-files-wrap${wtOpen ? " git-ls-wt-files-wrap--open" : ""}`}>
            <div className="git-ls-wt-files">
              {files.staged.length > 0 && <FileGroup label="staged" files={files.staged} variant="staged" onFileClick={onFileClick} activeFile={activeFile} />}
              {files.modified.length > 0 && <FileGroup label="modified" files={files.modified} variant="modified" onFileClick={onFileClick} activeFile={activeFile} />}
              {files.untracked.length > 0 && <FileGroup label="untracked" files={files.untracked} variant="untracked" onFileClick={onFileClick} activeFile={activeFile} />}
            </div>
          </div>
        </div>
      )}
      <div className="git-ls-meta">
        <span className="git-section-label">contributors</span>
        <span className="git-ls-authors">{authors.join(", ")}</span>
      </div>
    </div>
  );
}

function FileGroup({ label, files, variant, onFileClick, activeFile }: {
  label: string; files: string[]; variant: string;
  onFileClick: (f: string) => void; activeFile: string | null;
}) {
  return (
    <div className="git-fg">
      <span className={`git-fg-label ${variant}`}>{label}</span>
      <div className="git-fg-files">
        {files.map((f) => (
          <button key={f} className={`git-fg-file ${variant}${activeFile === f ? " git-fg-file--active" : ""}`} onClick={() => onFileClick(f)}>{f}</button>
        ))}
      </div>
    </div>
  );
}

// ── Detail Pane components ──

function DetailPane({ state, cwd, status, commits }: {
  state: DetailState; cwd: string; status: GitStatus; commits: GitCommit[];
}) {
  if (state.kind === "overview") return <ReadmeDetail cwd={cwd} />;
  if (state.kind === "wt-file") return <WtFileDiff cwd={cwd} file={state.file} />;
  if (state.kind === "commit") return <CommitFullDetail cwd={cwd} hash={state.hash} commits={commits} />;
  if (state.kind === "commit-file") return <CommitFileDiff cwd={cwd} hash={state.hash} file={state.file} />;
  return null;
}

function ReadmeDetail({ cwd }: { cwd: string }) {
  const [readme, setReadme] = useState<{ name: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchGitReadme(cwd)
      .then((r) => { if (active) setReadme(r); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cwd]);

  if (loading) return <div className="git-detail-content"><div className="git-detail-loading">Loading...</div></div>;
  if (!readme) return <div className="git-detail-content"><div className="git-detail-empty">No README found</div></div>;

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">{readme.name}</span>
      </div>
      <div className="git-detail-scroll">
        <div className="git-readme-full message-content"><Markdown content={rewriteImagePaths(readme.content, cwd)} /></div>
      </div>
    </div>
  );
}

function WtFileDiff({ cwd, file }: { cwd: string; file: string }) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);

  useEffect(() => {
    let active = true;
    setDiffs(null);
    fetchGitFileDiff(cwd, file).then((d) => { if (active) setDiffs(d); }).catch(() => {});
    return () => { active = false; };
  }, [cwd, file]);

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">working tree</span>
        <span className="git-detail-head-file">{file}</span>
      </div>
      <div className="git-detail-scroll">
        {diffs === null ? (
          <div className="git-detail-loading">Loading...</div>
        ) : diffs.length === 0 ? (
          <div className="git-detail-loading">No diff (untracked or binary)</div>
        ) : (
          <DiffView files={diffs} />
        )}
      </div>
    </div>
  );
}

function CommitFullDetail({ hash, commits }: { cwd: string; hash: string; commits: GitCommit[] }) {
  const logEntry = commits.find((c) => c.hash === hash);
  if (!logEntry) return <div className="git-detail-content"><div className="git-detail-loading">Commit not found</div></div>;

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">commit</span>
        <span className="git-detail-head-hash">{shortHash(logEntry.hash)}</span>
      </div>
      <div className="git-detail-scroll">
        <div className="git-detail-commit-info">
          <div className="git-detail-commit-msg">{logEntry.message}</div>
          <div className="git-detail-commit-meta">
            <span>{logEntry.author}</span>
            <span className="git-detail-sep">·</span>
            <span>{timeAgo(logEntry.date)}</span>
            <span className="git-detail-sep">·</span>
            <span>{logEntry.filesChanged ?? 0} file{(logEntry.filesChanged ?? 0) !== 1 ? "s" : ""}</span>
            {(logEntry.additions ?? 0) > 0 && <span className="diff-stat diff-stat--add">+{logEntry.additions}</span>}
            {(logEntry.deletions ?? 0) > 0 && <span className="diff-stat diff-stat--del">-{logEntry.deletions}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function CommitFileDiff({ cwd, hash, file }: { cwd: string; hash: string; file: string }) {
  const pretty = isPrettyFile(file);
  const [mode, setMode] = useState<"diff" | "view">(pretty ? "view" : "diff");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  // Reset mode when file changes
  useEffect(() => { setMode(isPrettyFile(file) ? "view" : "diff"); }, [file]);

  // Fetch diff lazily
  useEffect(() => {
    if (mode !== "diff" || detail) return;
    let active = true;
    setLoadingDiff(true);
    fetchGitShow(cwd, hash)
      .then((d) => { if (active) setDetail(d); })
      .catch(() => {})
      .finally(() => { if (active) setLoadingDiff(false); });
    return () => { active = false; };
  }, [cwd, hash, mode, detail]);

  // Fetch file content lazily
  useEffect(() => {
    if (mode !== "view" || fileContent !== null) return;
    let active = true;
    setLoadingContent(true);
    fetchGitFileContent(cwd, hash, file)
      .then((c) => { if (active) setFileContent(c); })
      .catch(() => {})
      .finally(() => { if (active) setLoadingContent(false); });
    return () => { active = false; };
  }, [cwd, hash, file, mode, fileContent]);

  const isHtml = file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm");
  const isMd = file.toLowerCase().endsWith(".md");
  const fileDiff = detail?.files.find((f) => f.path === file);

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">{shortHash(hash)}</span>
        <span className="git-detail-head-file">{file}</span>
        <div className="git-view-toggle">
          <button className={`git-view-toggle-btn${mode === "diff" ? " git-view-toggle-btn--active" : ""}`} onClick={() => setMode("diff")}>diff</button>
          <button className={`git-view-toggle-btn${mode === "view" ? " git-view-toggle-btn--active" : ""}`} onClick={() => setMode("view")}>view</button>
        </div>
      </div>
      <div className="git-detail-scroll">
        {mode === "view" ? (
          loadingContent ? (
            <div className="git-detail-loading">Loading...</div>
          ) : fileContent === null ? (
            <div className="git-detail-loading">Could not load file</div>
          ) : isHtml ? (
            <iframe className="git-html-preview" srcDoc={fileContent} sandbox="allow-same-origin" title={file} />
          ) : isMd ? (
            <div className="git-readme-full message-content"><Markdown content={fileContent} /></div>
          ) : (
            <div className="git-file-raw"><pre className="git-file-raw-pre"><code>{fileContent}</code></pre></div>
          )
        ) : (
          loadingDiff ? (
            <div className="git-detail-loading">Loading...</div>
          ) : !fileDiff ? (
            <div className="git-detail-loading">File not found in commit</div>
          ) : (
            <div className="git-detail-single-diff">
              <table className="diff-table">
                {fileDiff.hunks.map((hunk, i) => (
                  <tbody className="diff-hunk-block" key={i}>
                    <tr className="diff-hunk-header">
                      <td className="diff-gutter" colSpan={3}></td>
                      <td className="diff-hunk-range">{hunk.header}</td>
                    </tr>
                    {hunk.lines.map((line, j) => (
                      <tr key={j} className={`diff-line diff-line--${line.type}`}>
                        <td className="diff-gutter diff-gutter--old">{line.oldNum ?? ""}</td>
                        <td className="diff-gutter diff-gutter--new">{line.newNum ?? ""}</td>
                        <td className="diff-gutter diff-gutter--marker">
                          {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                        </td>
                        <td className="diff-code"><span>{line.content}</span></td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ── Main ──

export function GitPanel({ cwd }: { cwd: string | null }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ kind: "overview" });
  const [commitDetails, setCommitDetails] = useState<Map<string, GitCommitDetail>>(new Map());
  const [loadingCommit, setLoadingCommit] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!cwd) return;
    try {
      const [s, l] = await Promise.all([fetchGitStatus(cwd), fetchGitLog(cwd)]);
      setStatus(s);
      setLog(l);
    } catch { /* silent */ }
  }, [cwd]);

  useEffect(() => {
    setStatus(null); setLog([]); setOpenCommit(null);
    setDetailState({ kind: "overview" }); setCommitDetails(new Map());
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  // Fetch commit detail when opened
  useEffect(() => {
    if (!openCommit || !cwd || commitDetails.has(openCommit)) return;
    let active = true;
    setLoadingCommit(openCommit);
    fetchGitShow(cwd, openCommit)
      .then((d) => {
        if (active && d) setCommitDetails((prev) => new Map(prev).set(openCommit, d));
      })
      .catch(() => {})
      .finally(() => { if (active) setLoadingCommit(null); });
    return () => { active = false; };
  }, [openCommit, cwd]);

  if (!cwd) return <div className="git-panel"><div className="git-empty">No working directory selected</div></div>;
  if (status === null) return <div className="git-panel"><div className="git-empty">Loading...</div></div>;
  if (!status.git) return <div className="git-panel"><div className="git-empty"><span className="git-empty-path">{cwd}</span> is not a git repository</div></div>;

  const maxVolume = Math.max(...log.map(changeVolume), 1);

  const handleTopBarClick = () => {
    setOpenCommit(null);
    setDetailState({ kind: "overview" });
  };

  const handleWtFile = (file: string) => {
    setOpenCommit(null);
    setDetailState((prev) =>
      prev.kind === "wt-file" && prev.file === file
        ? { kind: "overview" }
        : { kind: "wt-file", file }
    );
  };

  const handleCommitRowClick = (hash: string) => {
    if (openCommit === hash) {
      if (detailState.kind === "commit" && detailState.hash === hash) {
        setOpenCommit(null);
        setDetailState({ kind: "overview" });
      } else {
        setDetailState({ kind: "commit", hash });
      }
    } else {
      setOpenCommit(hash);
      setDetailState({ kind: "commit", hash });
    }
  };

  const handleCommitFile = (hash: string, filePath: string) => {
    setDetailState((prev) =>
      prev.kind === "commit-file" && prev.hash === hash && prev.file === filePath
        ? { kind: "commit", hash }
        : { kind: "commit-file", hash, file: filePath }
    );
  };

  const activeWtFile = detailState.kind === "wt-file" ? detailState.file : null;

  return (
    <div className="git-panel">
      <TopBar status={status} cwd={cwd} commits={log} onClick={handleTopBarClick} />
      <div className="git-split">
        <div className="git-left">
          <LeftSummary status={status} commits={log} onFileClick={handleWtFile} activeFile={activeWtFile} />
          <div className="git-commit-scroll">
            {log.map((c) => {
              const isOpen = openCommit === c.hash;
              const det = commitDetails.get(c.hash);
              const vol = changeVolume(c);
              const barPct = maxVolume > 0 ? Math.max(2, (vol / maxVolume) * 100) : 0;
              const isActiveFile = (path: string) =>
                detailState.kind === "commit-file" && detailState.hash === c.hash && detailState.file === path;

              return (
                <div key={c.hash} className={`git-ci${isOpen ? " git-ci--open" : ""}`}>
                  <button className="git-ci-row" onClick={() => handleCommitRowClick(c.hash)}>
                    <div className="git-ci-bar" style={{ width: `${barPct}%` }} />
                    <span className="git-ci-chevron-cell"><Chevron open={isOpen} /></span>
                    <span className="git-ci-time">{timeAgo(c.date)}</span>
                    <span className="git-ci-author">{c.author}</span>
                    <span className="git-ci-hash">{shortHash(c.hash)}</span>
                    <span className="git-ci-msg">{subject(c.message)}</span>
                    <span className="git-ci-stats">
                      {(c.filesChanged ?? 0) > 0 && <span className="git-ci-fcount">{c.filesChanged}f</span>}
                      {(c.additions ?? 0) > 0 && <span className="diff-stat diff-stat--add">+{c.additions}</span>}
                      {(c.deletions ?? 0) > 0 && <span className="diff-stat diff-stat--del">-{c.deletions}</span>}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="git-ci-expand">
                      {loadingCommit === c.hash && <div className="git-ci-expand-loading">Loading...</div>}
                      {det && det.files.map((f) => (
                        <button
                          key={f.path}
                          className={`git-ci-expand-file${isActiveFile(f.path) ? " git-ci-expand-file--active" : ""}`}
                          onClick={() => handleCommitFile(c.hash, f.path)}
                        >
                          <span className="git-ci-expand-file-name">{f.path}</span>
                          <span className="git-ci-expand-file-stats">
                            {f.additions > 0 && <span className="diff-stat diff-stat--add">+{f.additions}</span>}
                            {f.deletions > 0 && <span className="diff-stat diff-stat--del">-{f.deletions}</span>}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {log.length === 0 && <div className="git-empty">No commits</div>}
          </div>
        </div>

        <div className="git-right">
          <DetailPane state={detailState} cwd={cwd} status={status} commits={log} />
        </div>
      </div>
    </div>
  );
}
