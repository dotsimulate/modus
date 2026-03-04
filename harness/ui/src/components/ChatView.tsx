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
      isNearBottom.current = scrollHeight - scrollTop - clientHeight < 400;
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll when a new message is added
  useEffect(() => {
    if (!endRef.current) return;
    const last = messages[messages.length - 1];
    const userJustSent = last?.role === "user";
    if (userJustSent || isNearBottom.current) {
      requestAnimationFrame(() => {
        endRef.current?.scrollIntoView({ behavior: "instant" });
      });
    }
  }, [messages.length]);

  // During streaming, keep scrolling to bottom as content grows
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(() => {
      if (isNearBottom.current && endRef.current) {
        endRef.current.scrollIntoView({ behavior: "instant" });
      }
    }, 150);
    return () => clearInterval(interval);
  }, [streaming]);

  // Re-scroll on viewport resize (mobile keyboard open/close)
  useEffect(() => {
    const onResize = () => {
      if (isNearBottom.current && endRef.current) {
        endRef.current.scrollIntoView({ behavior: "instant" });
      }
    };
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", onResize);
      return () => vv.removeEventListener("resize", onResize);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

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
    <div className="chat-messages" ref={containerRef}>
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
      <div ref={endRef} />
    </div>
  );
}
