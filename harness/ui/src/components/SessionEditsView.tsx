import { useMemo } from "react";
import type { Message } from "../api";
import { extractFileEdits, FileCard, groupByFile, countChanges } from "./FileChanges";

type Props = {
  messages: Message[];
};

export function SessionEditsView({ messages }: Props) {
  const grouped = useMemo(() => {
    const allEdits = [];
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.toolCalls) {
        allEdits.push(...extractFileEdits(msg.toolCalls));
      }
    }
    return groupByFile(allEdits);
  }, [messages]);

  if (grouped.size === 0) {
    return <div className="panel-empty">no files edited this session</div>;
  }

  const allEdits = [...grouped.values()].flat();
  const total = countChanges(allEdits);

  return (
    <div className="fc-container session-edits-view">
      <div className="fc-container-inner">
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
      </div>
    </div>
  );
}
