import type { GitCommit } from "../api";
import { navigateToGitRoute } from "../git-route";

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

export function GitActivityItem({ commit }: Props) {
  return (
    <button
      className="git-activity"
      onClick={() => navigateToGitRoute({ commit: commit.hash })}
      type="button"
    >
      <span className="git-activity-dot" aria-hidden="true" />
      <span className="git-activity-label">commit</span>
      <span className="git-activity-hash">
        {shortHash(commit.hash)}
      </span>
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
    </button>
  );
}
