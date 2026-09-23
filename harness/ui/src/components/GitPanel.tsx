import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { API_BASE, modus, tokenParam } from "../modusClient";
import type { GitStatus, GitCommit, GitCommitDetail, FileDiff } from "../../../sdk/index";
import { replaceGitRouteState, useGitRouteState } from "../git-route";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";
import { ResizeHandle } from "./ResizeHandle";
import {
  Folder, FolderOpen,
  FileCode2, FileJson, FileText, FileTerminal, FileCog, File as FileGeneric,
} from "lucide-react";

// ── Helpers ──

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  const days = Math.floor(diff / 86400000);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

function shortHash(h: string) { return h.slice(0, 7); }
function subject(msg: string) { return msg.split("\n")[0] ?? msg; }

function formatNum(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function extractRepoName(status: GitStatus, cwd: string): string {
  if (status.remote) {
    const name = status.remote.split("/").pop()?.replace(/\.git$/, "");
    if (name) return name;
  }
  return cwd.split("/").pop() ?? cwd;
}

function rewriteImagePaths(md: string, cwd: string): string {
  const base = `${API_BASE}/api/git/raw/`;
  const token = tokenParam();
  const params = `?cwd=${encodeURIComponent(cwd)}${token ? `&${token}` : ""}`;
  md = md.replace(/(<img\s[^>]*?src=["'])(?!https?:\/\/|\/)(.*?)(["'])/gi,
    (_, pre, path, post) => `${pre}${base}${path}${params}${post}`);
  md = md.replace(/(!\[[^\]]*\]\()(?!https?:\/\/|\/)([^)]+)(\))/g,
    (_, pre, path, post) => `${pre}${base}${path}${params}${post}`);
  return md;
}

function isPrettyFile(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".html") || lower.endsWith(".htm");
}

/** Group commits by date → array of counts for the activity chart */
function dailyActivity(commits: GitCommit[]): number[] {
  if (commits.length === 0) return [];
  const byDay = new Map<string, number>();
  for (const c of commits) {
    const day = new Date(c.date).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  const dates = commits.map(c => new Date(c.date).getTime());
  const newest = Math.max(...dates);
  const oldest = Math.min(...dates);
  const span = Math.max(1, Math.ceil((newest - oldest) / 86400000) + 1);
  const bars = Math.min(span, 60);
  const result: number[] = [];
  for (let i = bars - 1; i >= 0; i--) {
    const d = new Date(newest);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push(byDay.get(key) ?? 0);
  }
  return result;
}

/** Compute date span label */
function dateSpanLabel(commits: GitCommit[]): string | null {
  if (commits.length < 2) return null;
  const dates = commits.map(c => new Date(c.date).getTime());
  const days = Math.ceil((Math.max(...dates) - Math.min(...dates)) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "1 day";
  if (days < 30) return `${days} days`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks !== 1 ? "s" : ""}`;
}

/** Group commits by day for timeline separators */
function groupByDay(commits: GitCommit[]): Map<string, GitCommit[]> {
  const groups = new Map<string, GitCommit[]>();
  for (const c of commits) {
    const day = new Date(c.date).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
    });
    const arr = groups.get(day) ?? [];
    arr.push(c);
    groups.set(day, arr);
  }
  return groups;
}

/** Count commits per author */
function authorStats(commits: GitCommit[]): Array<{ name: string; count: number }> {
  const map = new Map<string, number>();
  for (const c of commits) {
    map.set(c.author, (map.get(c.author) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

// ── File tree from flat paths ──

type FileStatus = "staged" | "modified" | "untracked";
type TreeNode = { name: string; path: string; children?: TreeNode[]; status?: FileStatus };

function buildFileTree(entries: Array<{ path: string; status: FileStatus }>): TreeNode[] {
  const root: TreeNode[] = [];
  for (const { path, status } of entries) {
    const parts = path.split("/");
    let level = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      let node = level.find(n => n.name === name);
      if (!node) {
        node = { name, path: parts.slice(0, i + 1).join("/"), ...(isFile ? { status } : { children: [] }) };
        level.push(node);
      }
      if (!isFile) level = node.children!;
    }
  }
  // Sort: dirs first, then files, alphabetical within each group
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = !!a.children, bDir = !!b.children;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) if (n.children) sortNodes(n.children);
  };
  sortNodes(root);
  return root;
}

const ICON_SIZE = 11;
const ICON_STROKE = 1.5;

function wtFileIcon(name: string) {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  let Icon = FileGeneric;
  let color = "var(--text-muted)";
  if (["ts", "tsx"].includes(ext))                        { Icon = FileCode2;    color = "#3178c6"; }
  else if (["js", "jsx", "mjs", "cjs"].includes(ext))    { Icon = FileCode2;    color = "#c8a82e"; }
  else if (["py"].includes(ext))                          { Icon = FileCode2;    color = "#4b8bbe"; }
  else if (["rs"].includes(ext))                          { Icon = FileCode2;    color = "#ce422b"; }
  else if (["go"].includes(ext))                          { Icon = FileCode2;    color = "#00add8"; }
  else if (["css", "scss", "less"].includes(ext))         { Icon = FileCode2;    color = "#569cd6"; }
  else if (["html", "htm"].includes(ext))                 { Icon = FileCode2;    color = "#c66d3e"; }
  else if (["json", "jsonc"].includes(ext))               { Icon = FileJson;     color = "#8a8a2a"; }
  else if (["md", "mdx"].includes(ext))                   { Icon = FileText;     color = "#6a9955"; }
  else if (["sh", "bash", "zsh"].includes(ext))           { Icon = FileTerminal; color = "#89e051"; }
  else if (["yaml", "yml", "toml", "ini"].includes(ext)) { Icon = FileCog;      color = "#8b7daa"; }
  return (
    <span className="fb-file-icon" aria-hidden>
      <Icon size={ICON_SIZE} strokeWidth={ICON_STROKE} color={color} />
    </span>
  );
}

const statusColor: Record<FileStatus, string> = {
  staged: "var(--success)",
  modified: "var(--warning)",
  untracked: "var(--text-muted)",
};

function FileTreeNodes({ nodes, depth, onFileClick, activeFile, expandedDirs, toggleDir }: {
  nodes: TreeNode[]; depth: number;
  onFileClick: (path: string) => void; activeFile: string | null;
  expandedDirs: Set<string>; toggleDir: (path: string) => void;
}) {
  const chevron = (open: boolean) => (
    <svg width="6" height="6" viewBox="0 0 6 6" fill="none"
      style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s ease" }}>
      <path d="M1.5 0.5L4.5 3L1.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );

  return (
    <>
      {nodes.map(node => {
        const isDir = !!node.children;
        const isOpen = expandedDirs.has(node.path);
        const paddingLeft = 8 + depth * 14;

        if (isDir) {
          return (
            <div key={node.path}>
              <button
                className="fb-entry fb-entry--dir"
                style={{ paddingLeft }}
                onClick={() => toggleDir(node.path)}
                type="button"
              >
                <span className="fb-entry-chevron">{chevron(isOpen)}</span>
                <span className="fb-entry-icon">
                  {isOpen
                    ? <FolderOpen size={ICON_SIZE} strokeWidth={ICON_STROKE} color="var(--text-muted)" />
                    : <Folder size={ICON_SIZE} strokeWidth={ICON_STROKE} color="var(--text-muted)" />
                  }
                </span>
                <span className="fb-entry-name">{node.name}</span>
              </button>
              {isOpen && (
                <div className="fb-group" style={{ "--guide-left": `${paddingLeft + 3}px` } as React.CSSProperties}>
                  <FileTreeNodes
                    nodes={node.children!}
                    depth={depth + 1}
                    onFileClick={onFileClick}
                    activeFile={activeFile}
                    expandedDirs={expandedDirs}
                    toggleDir={toggleDir}
                  />
                </div>
              )}
            </div>
          );
        }

        return (
          <button
            key={node.path}
            className={`fb-entry fb-entry--file${activeFile === node.path ? " fb-entry--active" : ""}`}
            style={{ paddingLeft }}
            onClick={() => onFileClick(node.path)}
            type="button"
          >
            {wtFileIcon(node.name)}
            <span className="fb-entry-name" style={{ color: node.status ? statusColor[node.status] : undefined }}>
              {node.name}
            </span>
          </button>
        );
      })}
    </>
  );
}

// ── Micro components ──

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`git-chevron${open ? " git-chevron--open" : ""}`} width="8" height="8" viewBox="0 0 8 8">
      <path d="M2.5 1.5L5 4L2.5 6.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const widgetChevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

// ── Detail state ──

type DetailState =
  | { kind: "overview" }
  | { kind: "wt-file"; file: string }
  | { kind: "commit"; hash: string }
  | { kind: "commit-file"; hash: string; file: string };

// ══════════════════════════════════════════════════════════
// LEFT SIDEBAR WIDGETS
// ══════════════════════════════════════════════════════════

function SidebarWidget({ title, badge, defaultOpen = true, children }: {
  title: string; badge?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="git-widget">
      <button className="git-widget-header" onClick={() => setOpen(!open)} type="button">
        <span className="git-widget-title">{title}</span>
        {badge && <span className="git-widget-badge">{badge}</span>}
        <span className={`git-widget-chevron${open ? " git-widget-chevron--open" : ""}`}>
          {widgetChevron}
        </span>
      </button>
      <div className={`git-widget-collapse${open ? " git-widget-collapse--open" : ""}`}>
        <div className="git-widget-clip">
          <div className="git-widget-body">{children}</div>
        </div>
      </div>
    </div>
  );
}

function StatsWidget({ commits }: { commits: GitCommit[] }) {
  const totalAdd = commits.reduce((s, c) => s + (c.additions ?? 0), 0);
  const totalDel = commits.reduce((s, c) => s + (c.deletions ?? 0), 0);
  const totalFiles = commits.reduce((s, c) => s + (c.filesChanged ?? 0), 0);
  const authors = [...new Set(commits.map(c => c.author))];
  const activity = useMemo(() => dailyActivity(commits), [commits]);
  const maxBar = Math.max(...activity, 1);

  if (commits.length === 0) return null;

  return (
    <>
      <div className="git-kpi-row">
        <div className="git-kpi">
          <span className="git-kpi-value">{formatNum(commits.length)}</span>
          <span className="git-kpi-label">commits</span>
        </div>
        <div className="git-kpi">
          <span className="git-kpi-value">{formatNum(totalFiles)}</span>
          <span className="git-kpi-label">files</span>
        </div>
        <div className="git-kpi">
          <span className="git-kpi-value git-kpi-value--add">+{formatNum(totalAdd)}</span>
          <span className="git-kpi-label">add</span>
        </div>
        <div className="git-kpi">
          <span className="git-kpi-value git-kpi-value--del">-{formatNum(totalDel)}</span>
          <span className="git-kpi-label">del</span>
        </div>
      </div>
      {activity.length > 1 && (
        <div className="git-chart">
          {activity.map((count, i) => (
            <div
              key={i}
              className="git-chart-bar"
              style={{
                height: count > 0 ? `${Math.max(8, (count / maxBar) * 100)}%` : "1px",
                background: count > 0 ? "var(--border-active)" : "var(--border)",
              }}
            />
          ))}
        </div>
      )}
      {authors.length > 1 && (
        <div className="git-stats-authors">{authors.length} contributors</div>
      )}
    </>
  );
}

function WorkingTreeWidget({ status, onFileClick, activeFile }: {
  status: GitStatus; onFileClick: (f: string) => void; activeFile: string | null;
}) {
  const files = status.files;
  const count = (files?.modified.length ?? 0) + (files?.staged.length ?? 0) + (files?.untracked.length ?? 0);

  // Build combined tree from all file categories
  const treeEntries = useMemo(() => {
    if (!files) return [];
    const entries: Array<{ path: string; status: FileStatus }> = [];
    for (const f of files.staged) entries.push({ path: f, status: "staged" });
    for (const f of files.modified) entries.push({ path: f, status: "modified" });
    for (const f of files.untracked) entries.push({ path: f, status: "untracked" });
    return entries;
  }, [files]);

  const tree = useMemo(() => buildFileTree(treeEntries), [treeEntries]);

  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const initialized = useRef(false);

  // Auto-expand all directories once on first non-empty tree; preserve user
  // collapse state across subsequent polls.
  useEffect(() => {
    if (initialized.current) return;
    if (tree.length === 0) return;
    const dirs = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children) { dirs.add(n.path); collect(n.children); }
      }
    };
    collect(tree);
    setExpandedDirs(dirs);
    initialized.current = true;
  }, [tree]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const resetTree = useCallback(() => {
    const dirs = new Set<string>();
    const collect = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.children) { dirs.add(n.path); collect(n.children); }
      }
    };
    collect(tree);
    setExpandedDirs(dirs);
  }, [tree]);

  if (count === 0 || !files) return null;

  return (
    <SidebarWidget title="working tree" badge={`${count}`} defaultOpen={true}>
      <div className="git-wt-actions">
        <button
          className="git-wt-reset"
          onClick={resetTree}
          type="button"
          title="Expand all"
        >
          expand all
        </button>
      </div>
      <div className="fb-list" style={{ maxHeight: "none", overflow: "visible" }}>
        <FileTreeNodes
          nodes={tree}
          depth={0}
          onFileClick={onFileClick}
          activeFile={activeFile}
          expandedDirs={expandedDirs}
          toggleDir={toggleDir}
        />
      </div>
    </SidebarWidget>
  );
}

function ContributorsWidget({ commits }: { commits: GitCommit[] }) {
  const contributors = useMemo(() => authorStats(commits), [commits]);
  if (contributors.length <= 1) return null;

  return (
    <SidebarWidget title="contributors" badge={`${contributors.length}`} defaultOpen={false}>
      <div className="git-contributors">
        {contributors.map(c => (
          <div key={c.name} className="git-contributor">
            <span className="git-contributor-name">{c.name}</span>
            <span className="git-contributor-count">{c.count}</span>
          </div>
        ))}
      </div>
    </SidebarWidget>
  );
}

// ══════════════════════════════════════════════════════════
// RIGHT DETAIL PANE COMPONENTS
// ══════════════════════════════════════════════════════════

function ReadmeDetail({ cwd }: { cwd: string }) {
  const [readme, setReadme] = useState<{ name: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    modus.gitReadme(cwd)
      .then(r => { if (active) setReadme(r); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cwd]);

  if (loading) return <div className="git-detail-content"><div className="git-detail-loading">Loading...</div></div>;
  if (!readme) return <div className="git-detail-content"><div className="git-detail-empty">No README</div></div>;

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">readme</span>
        <span className="git-detail-head-file">{readme.name}</span>
      </div>
      <div className="git-detail-scroll">
        <div className="git-readme-full message-content">
          <Markdown content={rewriteImagePaths(readme.content, cwd)} />
        </div>
      </div>
    </div>
  );
}

function WtFileDiff({ cwd, file }: { cwd: string; file: string }) {
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);

  useEffect(() => {
    let active = true;
    setDiffs(null);
    modus.gitFileDiff(file, cwd).then(d => { if (active) setDiffs(d); }).catch(() => {});
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

function CommitDetail({ entry, detail, onFileClick, activeFile }: {
  entry: GitCommit;
  detail: GitCommitDetail | null;
  onFileClick: (file: string) => void;
  activeFile: string | null;
}) {
  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <span className="git-detail-head-label">commit</span>
        <span className="git-detail-head-hash">{shortHash(entry.hash)}</span>
      </div>
      <div className="git-detail-scroll">
        <div className="git-commit-detail">
          <div className="git-commit-detail-msg">{entry.message}</div>
          <div className="git-commit-detail-meta">
            <span>{entry.author}</span>
            <span className="git-commit-detail-sep">·</span>
            <span>{timeAgo(entry.date)}</span>
            <span className="git-commit-detail-sep">·</span>
            <span>{entry.filesChanged ?? 0} file{(entry.filesChanged ?? 0) !== 1 ? "s" : ""}</span>
            {(entry.additions ?? 0) > 0 && <span className="diff-stat diff-stat--add">+{entry.additions}</span>}
            {(entry.deletions ?? 0) > 0 && <span className="diff-stat diff-stat--del">-{entry.deletions}</span>}
          </div>
          {detail && (
            <div className="git-commit-detail-files">
              {detail.files.map(f => (
                <button
                  key={f.path}
                  className={`git-commit-detail-file${activeFile === f.path ? " git-commit-detail-file--active" : ""}`}
                  onClick={() => onFileClick(f.path)}
                  type="button"
                >
                  <span className="git-commit-detail-file-name">{f.path}</span>
                  <span className="git-commit-detail-file-stats">
                    {f.additions > 0 && <span className="diff-stat diff-stat--add">+{f.additions}</span>}
                    {f.deletions > 0 && <span className="diff-stat diff-stat--del">-{f.deletions}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CommitFileDiff({ cwd, hash, file, onBack }: {
  cwd: string; hash: string; file: string; onBack: () => void;
}) {
  const pretty = isPrettyFile(file);
  const [mode, setMode] = useState<"diff" | "view">(pretty ? "view" : "diff");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => { setMode(isPrettyFile(file) ? "view" : "diff"); }, [file]);

  useEffect(() => {
    if (mode !== "diff" || detail) return;
    let active = true;
    setLoadingDiff(true);
    modus.gitShow(hash, cwd)
      .then(d => { if (active) setDetail(d); })
      .catch(() => {})
      .finally(() => { if (active) setLoadingDiff(false); });
    return () => { active = false; };
  }, [cwd, hash, mode, detail]);

  useEffect(() => {
    if (mode !== "view" || fileContent !== null) return;
    let active = true;
    setLoadingContent(true);
    modus.gitFileContent(file, cwd, hash)
      .then(c => { if (active) setFileContent(c); })
      .catch(() => {})
      .finally(() => { if (active) setLoadingContent(false); });
    return () => { active = false; };
  }, [cwd, hash, file, mode, fileContent]);

  const isHtml = file.toLowerCase().endsWith(".html") || file.toLowerCase().endsWith(".htm");
  const isMd = file.toLowerCase().endsWith(".md");
  const fileDiff = detail?.files.find(f => f.path === file);

  return (
    <div className="git-detail-content">
      <div className="git-detail-head">
        <button className="git-detail-head-back" onClick={onBack} type="button">
          {shortHash(hash)}
        </button>
        <span className="git-detail-head-file">{file}</span>
        {pretty && (
          <div className="git-view-toggle">
            <button className={`git-view-toggle-btn${mode === "diff" ? " git-view-toggle-btn--active" : ""}`} onClick={() => setMode("diff")} type="button">diff</button>
            <button className={`git-view-toggle-btn${mode === "view" ? " git-view-toggle-btn--active" : ""}`} onClick={() => setMode("view")} type="button">view</button>
          </div>
        )}
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

// ── Detail Pane Router ──

function DetailPane({ state, cwd, commits, commitDetails, onCommitFile, onBackToCommit }: {
  state: DetailState;
  cwd: string;
  commits: GitCommit[];
  commitDetails: Map<string, GitCommitDetail>;
  onCommitFile: (hash: string, file: string) => void;
  onBackToCommit: (hash: string) => void;
}) {
  if (state.kind === "overview") return <ReadmeDetail cwd={cwd} />;
  if (state.kind === "wt-file") return <WtFileDiff cwd={cwd} file={state.file} />;
  if (state.kind === "commit") {
    const entry = commits.find(c => c.hash === state.hash);
    if (!entry) return <div className="git-detail-content"><div className="git-detail-loading">Commit not found</div></div>;
    const detail = commitDetails.get(state.hash) ?? null;
    return (
      <CommitDetail
        entry={entry}
        detail={detail}
        onFileClick={(f) => onCommitFile(state.hash, f)}
        activeFile={null}
      />
    );
  }
  if (state.kind === "commit-file") {
    return (
      <CommitFileDiff
        cwd={cwd}
        hash={state.hash}
        file={state.file}
        onBack={() => onBackToCommit(state.hash)}
      />
    );
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 280;
const DETAIL_MIN = 320;
const DETAIL_MAX = 1200;
const DETAIL_DEFAULT = 560;

function readStoredWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  } catch {
    return fallback;
  }
}

export function GitPanel({ cwd }: { cwd: string | null }) {
  const route = useGitRouteState();
  const effectiveCwd = cwd;
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [log, setLog] = useState<GitCommit[]>([]);
  const [openCommit, setOpenCommit] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ kind: "overview" });
  const [commitDetails, setCommitDetails] = useState<Map<string, GitCommitDetail>>(new Map());
  const [loadingCommit, setLoadingCommit] = useState<string | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState<number>(
    () => readStoredWidth("modus.git.sidebarWidth", SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)
  );
  const [detailWidth, setDetailWidth] = useState<number>(
    () => readStoredWidth("modus.git.detailWidth", DETAIL_DEFAULT, DETAIL_MIN, DETAIL_MAX)
  );

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth(prev => {
      const next = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, prev + delta));
      try { localStorage.setItem("modus.git.sidebarWidth", String(next)); } catch {}
      return next;
    });
  }, []);

  const handleDetailResize = useCallback((delta: number) => {
    setDetailWidth(prev => {
      const next = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, prev + delta));
      try { localStorage.setItem("modus.git.detailWidth", String(next)); } catch {}
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!effectiveCwd) return;
    try {
      const [s, l] = await Promise.all([modus.gitStatus(effectiveCwd), modus.gitLog(effectiveCwd, 500)]);
      setStatus(s);
      setLog(l);
    } catch { /* silent */ }
  }, [effectiveCwd]);

  useEffect(() => {
    setStatus(null); setLog([]); setOpenCommit(null);
    setDetailState({ kind: "overview" }); setCommitDetails(new Map());
    // Settle-then-schedule: a slow `git status` in a large repo must not stack
    // a second one behind it on the tab's few HTTP connections.
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      await load();
      if (active) timer = setTimeout(() => { void poll(); }, 10_000);
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [load]);

  // Sync route → state
  useEffect(() => {
    if (route.wt) {
      setOpenCommit(null);
      setDetailState({ kind: "wt-file", file: route.wt });
      return;
    }
    if (route.commit && route.file) {
      setOpenCommit(route.commit);
      setDetailState({ kind: "commit-file", hash: route.commit, file: route.file });
      return;
    }
    if (route.commit) {
      setOpenCommit(route.commit);
      setDetailState({ kind: "commit", hash: route.commit });
      return;
    }
    setOpenCommit(null);
    setDetailState({ kind: "overview" });
  }, [route.commit, route.file, route.wt]);

  // Fetch commit detail when opened
  useEffect(() => {
    if (!openCommit || !effectiveCwd || commitDetails.has(openCommit)) return;
    let active = true;
    setLoadingCommit(openCommit);
    modus.gitShow(openCommit, effectiveCwd)
      .then(d => {
        if (active && d) setCommitDetails(prev => new Map(prev).set(openCommit, d));
      })
      .catch(() => {})
      .finally(() => { if (active) setLoadingCommit(null); });
    return () => { active = false; };
  }, [openCommit, effectiveCwd, commitDetails]);

  // Derived data
  const dayGroups = useMemo(() => groupByDay(log), [log]);
  const span = useMemo(() => dateSpanLabel(log), [log]);

  if (!effectiveCwd) return <div className="git-panel"><div className="git-empty">No working directory selected</div></div>;
  if (status === null) return <div className="git-panel"><div className="git-empty">Loading...</div></div>;
  if (!status.git) return <div className="git-panel"><div className="git-empty"><span className="git-empty-path">{effectiveCwd}</span> is not a git repository</div></div>;

  // ── Event handlers ──

  const handleOverview = () => replaceGitRouteState({});

  const handleWtFile = (file: string) => {
    replaceGitRouteState(
      detailState.kind === "wt-file" && detailState.file === file
        ? {}
        : { wt: file }
    );
  };

  const handleCommitRowClick = (hash: string) => {
    if (openCommit === hash) {
      if (detailState.kind === "commit" && detailState.hash === hash) {
        replaceGitRouteState({});
      } else {
        replaceGitRouteState({ commit: hash });
      }
    } else {
      replaceGitRouteState({ commit: hash });
    }
  };

  const handleCommitFile = (hash: string, filePath: string) => {
    replaceGitRouteState(
      detailState.kind === "commit-file" && detailState.hash === hash && detailState.file === filePath
        ? { commit: hash }
        : { commit: hash, file: filePath }
    );
  };

  const handleBackToCommit = (hash: string) => {
    replaceGitRouteState({ commit: hash });
  };

  const activeWtFile = detailState.kind === "wt-file" ? detailState.file : null;
  const fileCount = (status.files?.modified.length ?? 0)
    + (status.files?.staged.length ?? 0)
    + (status.files?.untracked.length ?? 0);
  const isDirty = fileCount > 0;

  const panelStyle = {
    "--git-sidebar-width": `${sidebarWidth}px`,
    "--git-detail-width": `${detailWidth}px`,
  } as React.CSSProperties;

  return (
    <div className="git-panel" style={panelStyle}>
      {/* ── LEFT SIDEBAR ── */}
      <div className="git-sidebar">
        <div className="git-repo-identity">
          <div className="git-repo-name" onClick={handleOverview}>
            {extractRepoName(status, effectiveCwd)}
          </div>
          <div className="git-repo-meta">
            <div className="git-repo-row">
              <span className="git-repo-branch-icon">⎇</span>
              <span>{status.branch}</span>
              <span className={`git-repo-dot git-repo-dot--${isDirty ? "dirty" : "clean"}`} />
              {((status.ahead ?? 0) > 0 || (status.behind ?? 0) > 0) && (
                <span className="git-repo-sync">
                  {(status.ahead ?? 0) > 0 && <span className="git-repo-sync-ahead">↑{status.ahead}</span>}
                  {(status.behind ?? 0) > 0 && <span className="git-repo-sync-behind">↓{status.behind}</span>}
                </span>
              )}
            </div>
            {status.remote && (
              <div className="git-repo-row">
                <span className="git-repo-remote">{status.remote}</span>
              </div>
            )}
          </div>
        </div>

        <div className="git-sidebar-scroll">
          <SidebarWidget title="activity" badge={span ?? undefined} defaultOpen={true}>
            <StatsWidget commits={log} />
          </SidebarWidget>

          <WorkingTreeWidget
            status={status}
            onFileClick={handleWtFile}
            activeFile={activeWtFile}
          />

          <ContributorsWidget commits={log} />
        </div>
      </div>

      <ResizeHandle side="left" onResize={handleSidebarResize} />

      {/* ── CENTER: COMMIT TIMELINE ── */}
      <div className="git-center">
        <div className="git-center-header">
          <span className="git-center-title">commits</span>
          <span className="git-center-count">{log.length}</span>
          {span && <span className="git-center-span">{span}</span>}
        </div>
        <div className="git-center-scroll">
          {[...dayGroups.entries()].map(([day, commits]) => (
            <div key={day}>
              <div className="git-day-sep">
                <span className="git-day-label">{day}</span>
                <span className="git-day-line" />
                <span className="git-day-count">{commits.length}</span>
              </div>
              {commits.map(c => {
                const isOpen = openCommit === c.hash;
                const det = commitDetails.get(c.hash);
                const isActiveFile = (path: string) =>
                  detailState.kind === "commit-file" && detailState.hash === c.hash && detailState.file === path;

                return (
                  <div key={c.hash} className={`git-ci${isOpen ? " git-ci--open" : ""}`}>
                    <button className="git-ci-row" onClick={() => handleCommitRowClick(c.hash)} type="button">
                      <span className="git-ci-chevron"><Chevron open={isOpen} /></span>
                      <span className="git-ci-time">{timeAgo(c.date)}</span>
                      <span className="git-ci-main">
                        <span className="git-ci-msg">{subject(c.message)}</span>
                        <span className="git-ci-sub">
                          <span className="git-ci-author">{c.author}</span>
                          <span className="git-ci-hash">{shortHash(c.hash)}</span>
                        </span>
                      </span>
                      <span className="git-ci-stats">
                        {(c.filesChanged ?? 0) > 0 && <span className="git-ci-fcount">{c.filesChanged}f</span>}
                        {(c.additions ?? 0) > 0 && <span className="diff-stat diff-stat--add">+{c.additions}</span>}
                        {(c.deletions ?? 0) > 0 && <span className="diff-stat diff-stat--del">-{c.deletions}</span>}
                      </span>
                    </button>
                    <div className={`git-ci-expand${isOpen ? " git-ci-expand--open" : ""}`}>
                      <div className="git-ci-expand-clip">
                        {isOpen && (
                          <div className="git-ci-expand-inner">
                            {loadingCommit === c.hash && <div className="git-ci-expand-loading">Loading...</div>}
                            {det && (
                              <>
                                <div className="git-ci-expand-meta">
                                  <span>{c.author}</span>
                                  <span className="git-ci-expand-meta-sep">·</span>
                                  <span>{timeAgo(c.date)}</span>
                                  {(c.filesChanged ?? 0) > 0 && (
                                    <>
                                      <span className="git-ci-expand-meta-sep">·</span>
                                      <span>{c.filesChanged} file{(c.filesChanged ?? 0) !== 1 ? "s" : ""}</span>
                                    </>
                                  )}
                                </div>
                                {det.files.map(f => (
                                  <button
                                    key={f.path}
                                    className={`git-ci-file${isActiveFile(f.path) ? " git-ci-file--active" : ""}`}
                                    onClick={() => handleCommitFile(c.hash, f.path)}
                                    type="button"
                                  >
                                    <span className="git-ci-file-name">{f.path}</span>
                                    <span className="git-ci-file-stats">
                                      {f.additions > 0 && <span className="diff-stat diff-stat--add">+{f.additions}</span>}
                                      {f.deletions > 0 && <span className="diff-stat diff-stat--del">-{f.deletions}</span>}
                                    </span>
                                  </button>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          {log.length === 0 && <div className="git-empty">No commits</div>}
        </div>
      </div>

      <ResizeHandle side="right" onResize={handleDetailResize} />

      {/* ── RIGHT DETAIL PANE ── */}
      <div className="git-detail">
        <DetailPane
          state={detailState}
          cwd={effectiveCwd}
          commits={log}
          commitDetails={commitDetails}
          onCommitFile={handleCommitFile}
          onBackToCommit={handleBackToCommit}
        />
      </div>
    </div>
  );
}
