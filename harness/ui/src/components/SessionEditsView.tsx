import { useMemo, useEffect, useState, useCallback } from "react";
import type { Message, GitCommit, TouchRecord } from "../../../sdk/index";
import { FileCard, countChanges } from "./FileChanges";
import { GitActivityItem } from "./GitActivityItem";
import { modus } from "../modusClient";
import { mergeSessionEdits } from "../sessionEditsModel";

type Props = {
  messages: Message[];
  sessionId?: string | null;
  cwd?: string | null;
};

export function SessionEditsView({ messages, sessionId, cwd }: Props) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [claimedHashes, setClaimedHashes] = useState<Set<string>>(new Set());
  const [touches, setTouches] = useState<TouchRecord[]>([]);
  const [traceState, setTraceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [traceReload, setTraceReload] = useState(0);

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

  useEffect(() => {
    let active = true;
    if (!sessionId) {
      queueMicrotask(() => {
        if (!active) return;
        setTouches([]);
        setTraceState("ready");
      });
      return () => { active = false; };
    }

    queueMicrotask(() => {
      if (active) setTraceState("loading");
    });
    const loadTouches = async () => {
      try {
        const response = await modus.fetchTouches({
          sessionId,
          ops: ["write", "edit"],
        });
        if (!active) return;
        setTouches(response.touches);
        setTraceState("ready");
      } catch {
        if (active) setTraceState("error");
      }
    };

    void loadTouches();
    const timer = window.setInterval(() => { void loadTouches(); }, 4000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [sessionId, traceReload]);

  const grouped = useMemo(
    () => mergeSessionEdits(messages, touches, cwd),
    [messages, touches, cwd],
  );

  const allEdits = [...grouped.values()].flat();
  const total = countChanges(allEdits);

  const isEmpty = grouped.size === 0 && commits.length === 0;
  if (isEmpty && traceState === "loading") {
    return <div className="panel-empty">loading files edited this session<span className="sev-loading-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></div>;
  }
  if (isEmpty && traceState === "error") {
    return (
      <div className="panel-empty">
        couldn't load session file trace
        <button className="sev-trace-retry" type="button" onClick={() => setTraceReload((value) => value + 1)}>retry</button>
      </div>
    );
  }
  if (isEmpty) {
    return <div className="panel-empty">no files edited this session</div>;
  }

  return (
    <div className="fc-container session-edits-view">
      <div className="fc-container-inner">
        {traceState === "error" && (
          <div className="sev-trace-warning">
            session trace unavailable; showing loaded details only
            <button type="button" onClick={() => setTraceReload((value) => value + 1)}>retry</button>
          </div>
        )}
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
