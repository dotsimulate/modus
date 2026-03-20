import { useState } from "react";

interface Props {
  thinking: string;
  duration?: number | null;
  isStreaming?: boolean;
  hasContent?: boolean;
}

export function ThinkingBlock({ thinking, duration, isStreaming, hasContent }: Props) {
  const [expanded, setExpanded] = useState(false);

  const meta = duration != null
    ? `thought for ${(duration / 1000).toFixed(1)}s`
    : (isStreaming && !hasContent ? "thinking…" : null);

  return (
    <div
      className={`thinking-block ${expanded ? "expanded" : ""}`}
      onClick={!expanded ? () => setExpanded(true) : undefined}
    >
      <div
        className="thinking-gutter"
        onClick={expanded ? (e) => { e.stopPropagation(); setExpanded(false); } : undefined}
      >
        <span className="thinking-gutter-line" />
      </div>
      <div className="thinking-body">
        {meta && (
          <div
            className="thinking-meta"
            onClick={expanded ? () => setExpanded(false) : undefined}
          >
            {meta}
          </div>
        )}
        <div className="message-thinking">{thinking}</div>
      </div>
    </div>
  );
}
