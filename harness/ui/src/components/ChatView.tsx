import { useEffect, useRef } from "react";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "../types";

type Props = {
  messages: Message[];
  streaming: boolean;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  emptyTitle?: string;
  emptySubtitle?: string;
};

export function ChatView({ messages, streaming, showThinking = true, showMeta = true, showToolCalls = true, emptyTitle, emptySubtitle }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  // Scroll to bottom on initial load and when user sends a message.
  // All other auto-scrolling is handled by CSS overflow-anchor.
  useEffect(() => {
    if (!endRef.current || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!hasScrolledRef.current || last?.role === "user") {
      hasScrolledRef.current = true;
      endRef.current.scrollIntoView({ behavior: "instant" });
    }
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">{emptyTitle ?? "ready"}</div>
        <div className="empty-state-sub">{emptySubtitle ?? "start typing to begin"}</div>
      </div>
    );
  }

  // Find last message index per role for animation
  const lastUser = messages.findLastIndex(m => m.role === "user");
  const lastAssistant = messages.findLastIndex(m => m.role === "assistant");

  // Find last TodoWrite tool call ID so only it defaults expanded
  let lastTodoId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const tcs = messages[i].toolCalls;
    if (tcs) {
      for (let j = tcs.length - 1; j >= 0; j--) {
        if (tcs[j].name === "TodoWrite") { lastTodoId = tcs[j].id; break; }
      }
      if (lastTodoId) break;
    }
  }

  return (
    <div className="chat-messages">
      {messages.map((msg, i) =>
        msg.role === "system" ? (
          <div key={msg.id} className="system-divider">
            <span>{msg.content}</span>
          </div>
        ) : (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isNew={streaming && (
              (i === lastUser && msg.role === "user") ||
              (i === lastAssistant && msg.role === "assistant" && !msg.meta)
            )}
            isStreaming={
              streaming && i === messages.length - 1 && msg.role === "assistant"
            }
            hideRole={i > 0 && messages[i - 1].role === msg.role}
            showThinking={showThinking}
            showMeta={showMeta}
            showToolCalls={showToolCalls}
            lastTodoId={lastTodoId}
          />
        )
      )}
      <div ref={endRef} className="chat-anchor" />
    </div>
  );
}
