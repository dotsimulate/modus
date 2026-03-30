import { useMemo, useEffect, useState, useCallback } from "react";
import type { Message, GitCommit } from "../../../sdk/index";
import { extractFileEdits, FileCard, groupByFile, countChanges } from "./FileChanges";
import { GitActivityItem } from "./GitActivityItem";
import { modus } from "../modusClient";

type Props = {
  messages: Message[];
  sessionId?: string | null;
  cwd?: string | null;
};

export function SessionEditsView({ messages, sessionId, cwd }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [claimedHashes, setClaimedHashes] = useState<Set<string>>(new Set());

  const loadCommits = useCallback(async () => {
    if (!sessionId || !cwd) return;
    const [tags, log] = await Promise.all([
      modus.getTags(sessionId),
      modus.gitLog(cwd, 100),
    ]);
    const tagHashes = new Set(
      tags
        .filter((t) => t.startsWith("commit:"))
        .map((t) => t.slice("commit:".length))
    );
    setClaimedHashes(tagHashes);
    setCommits(log.filter((c) => tagHashes.has(c.hash.slice(0, 7))));
  }, [sessionId, cwd]);

  useEffect(() => {
    loadCommits().catch(() => {});
  }, [loadCommits]);

  const grouped = useMemo(() => {
    const allEdits = [];
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        allEdits.push(...extractFileEdits(msg.toolCalls));
      }
    }
    return groupByFile(allEdits);
  }, [messages]);

  const allEdits = [...grouped.values()].flat();
  const total = countChanges(allEdits);

  const isEmpty = grouped.size === 0 && commits.length === 0;
  if (isEmpty) {
    return <div className="panel-empty">no files edited this session</div>;
  }

  return (
    <div className="fc-container session-edits-view">
      <div className="fc-container-inner">
        {commits.length > 0 && (
          <div className="sev-commits">
            {commits.map((commit) => (
              <GitActivityItem
                key={commit.hash}
                commit={commit}
                sessionId={sessionId}
                claimedBySession={claimedHashes.has(commit.hash.slice(0, 7))}
                onClaimChange={loadCommits}
              />
            ))}
          </div>
        )}
        {grouped.size > 0 && (
          <>
            <div className="fc-header">
              <span className="fc-header-label">
                {grouped.size} file{grouped.size !== 1 ? "s" : ""} edited this session
              </span>
              <span className="fc-header-stats">
                {total.additions > 0 && <span className="diff-stat diff-stat--add">+{total.additions}</span>}
                {total.deletions > 0 && <span className="diff-stat diff-stat--del">-{total.deletions}</span>}
              </span>
            </div>
            <div className="fc-files">
              {[...grouped.entries()].map(([fp, edits]) => (
                <FileCard key={fp} filePath={fp} edits={edits} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
