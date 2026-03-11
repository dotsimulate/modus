import type { GitActivity } from "../api";

type Props = {
  activity: GitActivity;
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

export function GitActivityItem({ activity }: Props) {
  return (
    <div className="git-activity" data-subtype={activity.subtype}>
      <div className="git-activity-gutter" aria-hidden="true">
        <span className="git-activity-dot" />
      </div>
      <div className="git-activity-body">
        <div className="git-activity-line">
          <span className="git-activity-label">commit</span>
          <span className="git-activity-message">{activity.message || "(no message)"}</span>
        </div>
        <div className="git-activity-meta">
          <span className="git-activity-hash">{shortHash(activity.hash)}</span>
          {activity.branch && <span>{activity.branch}</span>}
          {activity.filesChanged != null && (
            <span>{activity.filesChanged} file{activity.filesChanged === 1 ? "" : "s"}</span>
          )}
          {activity.additions ? <span className="diff-stat diff-stat--add">+{activity.additions}</span> : null}
          {activity.deletions ? <span className="diff-stat diff-stat--del">-{activity.deletions}</span> : null}
          {activity.author && <span>{activity.author}</span>}
          <span>{formatWhen(activity.date)}</span>
        </div>
      </div>
    </div>
  );
}
