import type { GitCommit } from "../api";

type Props = {
  commit: GitCommit;
};

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function formatWhen(date: string): string {
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function navigateToGit() {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const slash = hash.indexOf("/");
  if (slash !== -1) {
    window.location.hash = `${hash.slice(0, slash)}/git`;
  } else {
    window.location.hash = "git";
  }
}

export function GitActivityItem({ commit }: Props) {
  return (
    <div className="git-activity">
      <span className="git-activity-dot" aria-hidden="true" />
      <span className="git-activity-label">commit</span>
      <button className="git-activity-hash" onClick={navigateToGit} type="button">
        {shortHash(commit.hash)}
      </button>
      <span className="git-activity-message">{commit.message || "(no message)"}</span>
      <span className="git-activity-meta">
        {commit.filesChanged != null && (
          <span>{commit.filesChanged}f</span>
        )}
        {commit.additions ? <span className="diff-stat diff-stat--add">+{commit.additions}</span> : null}
        {commit.deletions ? <span className="diff-stat diff-stat--del">-{commit.deletions}</span> : null}
        {commit.author && <span>{commit.author}</span>}
        <span>{formatWhen(commit.date)}</span>
      </span>
    </div>
  );
}
