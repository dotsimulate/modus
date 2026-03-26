import { useEffect, useState } from "react";
import { modus } from "../modusClient";
import type { GitCommit } from "../../../sdk/index";
import { navigateToGitRoute } from "../git-route";

type Props = {
  commit: GitCommit;
  sessionId?: string | null;
  claimedBySession?: boolean;
  onClaimChange?: () => void;
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

export function GitActivityItem({ commit, sessionId, claimedBySession, onClaimChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [optimisticClaimed, setOptimisticClaimed] = useState<boolean | null>(null);
  const hash = shortHash(commit.hash);
  const tag = `commit:${hash}`;
  const claimed = optimisticClaimed ?? claimedBySession ?? false;

  useEffect(() => {
    if (optimisticClaimed == null) return;
    if (optimisticClaimed === claimedBySession) {
      setOptimisticClaimed(null);
    }
  }, [claimedBySession, optimisticClaimed]);

  async function submitClaim(nextClaimed: boolean) {
    if (!sessionId || busy) return;
    setBusy(true);
    setOptimisticClaimed(nextClaimed);
    try {
      if (nextClaimed) {
        await modus.addTag(sessionId, tag);
      } else {
        await modus.removeTag(sessionId, tag);
      }
      onClaimChange?.();
    } catch {
      setOptimisticClaimed(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="git-activity">
      <button
        className="git-activity-main"
        onClick={() => navigateToGitRoute({ commit: commit.hash })}
        type="button"
      >
        <span className="git-activity-dot" aria-hidden="true" />
        <span className="git-activity-label">commit</span>
        <span className="git-activity-hash">
          {hash}
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
      {sessionId && (
        <div className="git-activity-actions">
          <button
            className={`git-activity-claim${claimed ? " is-claimed" : ""}`}
            disabled={busy}
            onClick={() => void submitClaim(!claimed)}
            type="button"
          >
            {busy ? "saving" : claimed ? "claimed" : "claim"}
          </button>
        </div>
      )}
    </div>
  );
}
