import { useState } from "react";
import type { Message } from "../types";
import { ToolCallView } from "./ToolCall";

type Props = {
  msg: Message;
  isStreaming: boolean;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
};

export function MessageBubble({ msg, isStreaming, showThinking = true, showMeta = true, showToolCalls = true }: Props) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    <div className="message">
      <div className="message-role">{msg.role}</div>

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
          {msg.content}
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
          {msg.meta.duration != null && (
            <span>{(msg.meta.duration / 1000).toFixed(1)}s</span>
          )}
          {msg.meta.turns != null && <span>{msg.meta.turns} turns</span>}
        </div>
      )}
    </div>
  );
}
