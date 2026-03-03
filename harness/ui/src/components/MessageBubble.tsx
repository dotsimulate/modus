import { useState } from "react";
import type { Message } from "../types";
import { ToolCallView } from "./ToolCall";
import { Markdown } from "./Markdown";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M ";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k ";
  return n + " ";
}

type Props = {
  msg: Message;
  isStreaming: boolean;
  hideRole?: boolean;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
};

export function MessageBubble({ msg, isStreaming, hideRole = false, showThinking = true, showMeta = true, showToolCalls = true }: Props) {
  const [thinkingExpanded, setThinkingExpanded] = useState(true);

  return (
    <div className="message" data-role={msg.role}>
      {!hideRole && <div className="message-role">{msg.role}</div>}

      {showThinking && msg.thinking && (
        <div
          className={`message-thinking ${thinkingExpanded ? "expanded" : ""}`}
          onClick={() => setThinkingExpanded(!thinkingExpanded)}
        >
          {msg.thinking}
        </div>
      )}

      {showToolCalls && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="message-tools">
          {msg.toolCalls.map((tc) => (
            <ToolCallView key={tc.id} tool={tc} />
          ))}
        </div>
      )}

      {msg.content && (
        <div className="message-content">
          <Markdown content={msg.content} />
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      )}

      {!msg.content && isStreaming && (
        <div className="message-content">
          <span className="streaming-cursor" />
        </div>
      )}

      {showMeta && msg.meta && (
        <div className="message-meta">
          {msg.meta.model && <span>{msg.meta.model}</span>}
          {msg.meta.cost != null && (
            <span>${msg.meta.cost.toFixed(4)}</span>
          )}
          {msg.meta.turns != null && <span>{msg.meta.turns} turns</span>}
          {msg.meta.inputTokens != null && msg.meta.outputTokens != null && (
            <span className="meta-tokens">
              <span className="meta-arrow">&#x2193;</span>{fmtTokens(msg.meta.inputTokens)}
              <span className="meta-arrow">&#x2191;</span>{fmtTokens(msg.meta.outputTokens)}
            </span>
          )}
          {msg.meta.duration != null && (
            <span className="meta-duration">{(msg.meta.duration / 1000).toFixed(1)}s</span>
          )}
        </div>
      )}
    </div>
  );
}
