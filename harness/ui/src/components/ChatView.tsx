import { useEffect, useRef, useMemo } from "react";
import { MessageBubble } from "./MessageBubble";
import { FileChanges, extractFileEdits } from "./FileChanges";
import type { Message, ToolCall } from "../api";

type Props = {
  messages: Message[];
  streaming: boolean;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  showGitEvents?: boolean;
  cwd?: string | null;
  emptyTitle?: string;
  emptySubtitle?: string;
};

export function ChatView({ messages, streaming, showThinking = true, showMeta = true, showToolCalls = true, showGitEvents = true, cwd, emptyTitle, emptySubtitle }: Props) {
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

  // Find last message index per role for animation
  const lastUser = useMemo(() => messages.findLastIndex((m: Message) => m.role === "user"), [messages]);
  const lastAssistant = useMemo(() => messages.findLastIndex((m: Message) => m.role === "assistant"), [messages]);

  // Find last TodoWrite tool call ID so only it defaults expanded
  const lastTodoId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const tcs = messages[i].toolCalls;
      if (tcs) {
        for (let j = tcs.length - 1; j >= 0; j--) {
          if (tcs[j].name === "TodoWrite") return tcs[j].id;
        }
      }
    }
    return undefined;
  }, [messages]);

  // Aggregate file edits per turn — map from message index to aggregated tool calls.
  // A turn = all assistant messages between two user messages (or start/end of array).
  // FileChanges renders after the last assistant message of each turn.
  const turnFileEdits = useMemo(() => {
    const result = new Map<number, ToolCall[]>();
    let turnTools: ToolCall[] = [];
    let lastAssistantIdx = -1;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user") {
        if (lastAssistantIdx >= 0 && turnTools.length > 0) {
          result.set(lastAssistantIdx, turnTools);
        }
        turnTools = [];
        lastAssistantIdx = -1;
      } else if (msg.role === "assistant") {
        if (msg.toolCalls) turnTools.push(...msg.toolCalls);
        lastAssistantIdx = i;
      }
    }
    if (lastAssistantIdx >= 0 && turnTools.length > 0) {
      result.set(lastAssistantIdx, turnTools);
    }
    return result;
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
    <div className="chat-messages">
      {messages.map((msg, i) => {
        const turnTools = turnFileEdits.get(i);
        const showFileChanges = turnTools && extractFileEdits(turnTools).length > 0;

        return msg.role === "system" ? (
          <div key={msg.id} className="system-divider">
            <span>{msg.content}</span>
          </div>
        ) : (
          <div key={msg.id}>
            <MessageBubble
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
              showGitEvents={showGitEvents}
              cwd={cwd}
              lastTodoId={lastTodoId}
            />
            {showFileChanges && <FileChanges toolCalls={turnTools} />}
          </div>
        );
      })}
      <div ref={endRef} className="chat-anchor" />
    </div>
  );
}
