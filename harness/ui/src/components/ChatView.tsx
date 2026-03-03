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
  const containerRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);

  // Track if user is near bottom — only auto-scroll if they are
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottom.current = scrollHeight - scrollTop - clientHeight < 100;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll when messages change, but only if near bottom
  useEffect(() => {
    if (isNearBottom.current && endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">{emptyTitle ?? "ready"}</div>
        <div className="empty-state-sub">{emptySubtitle ?? "start typing to begin"}</div>
      </div>
    );
  }

  return (
    <div className="chat-messages" ref={containerRef}>
      {messages.map((msg, i) => (
        <MessageBubble
          key={msg.id}
          msg={msg}
          isStreaming={
            streaming && i === messages.length - 1 && msg.role === "assistant"
          }
          hideRole={i > 0 && messages[i - 1].role === msg.role}
          showThinking={showThinking}
          showMeta={showMeta}
          showToolCalls={showToolCalls}
        />
      ))}
      <div ref={endRef} />
    </div>
  );
}
