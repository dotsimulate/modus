import { memo, useState, useEffect, useRef, type ReactNode } from "react";
import type { Message, ToolCall } from "../api";
import { ToolCallView } from "./ToolCall";
import { Markdown } from "./Markdown";
import { ImageLightbox } from "./ImageLightbox";
import { StreamingCursor } from "./StreamingCursor";

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M ";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k ";
  return n + " ";
}

/** Count all tool calls recursively, including sub-agent nested tools */
function countAllTools(toolCalls?: ToolCall[]): number {
  if (!toolCalls) return 0;
  let n = toolCalls.length;
  for (const tc of toolCalls) {
    if (tc.subMessages) {
      for (const sub of tc.subMessages) {
        n += countAllTools(sub.toolCalls);
      }
    }
  }
  return n;
}

/** Live elapsed timer that ticks every second while active.
 *  Captures wall-clock start on first active render. */
function useElapsed(active: boolean): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (active) {
      if (!startRef.current) startRef.current = Date.now();
      const tick = () => setElapsed(Date.now() - startRef.current);
      tick();
      intervalRef.current = setInterval(tick, 1000);
      return () => clearInterval(intervalRef.current);
    }
    // Keep showing last elapsed after streaming ends (before meta arrives)
  }, [active]);

  return elapsed;
}

type Props = {
  msg: Message;
  isNew?: boolean;
  isStreaming: boolean;
  hideRole?: boolean;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  showGitEvents?: boolean;
  cwd?: string | null;
  lastTodoId?: string;
  streamFeed?: string;
  children?: ReactNode;
};

function formatMeta(meta: Message["meta"]): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (meta.cost != null) parts.push(`$${meta.cost.toFixed(4)}`);
  if (meta.turns != null) parts.push(`${meta.turns} turns`);
  if (meta.inputTokens != null && meta.outputTokens != null)
    parts.push(`↓${fmtTokens(meta.inputTokens).trim()} ↑${fmtTokens(meta.outputTokens).trim()}`);
  if (meta.duration != null) parts.push(`${(meta.duration / 1000).toFixed(1)}s`);
  return parts.join("  ");
}

export const MessageBubble = memo(function MessageBubble({ msg, isNew = false, isStreaming, hideRole = false, showThinking = true, showMeta = true, showToolCalls = true, showGitEvents = true, cwd, lastTodoId, streamFeed, children }: Props) {
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const wasStreamingRef = useRef(false);
  const toolCount = countAllTools(msg.toolCalls);
  const liveElapsed = useElapsed(isStreaming && !msg.meta);
  const duration = msg.meta?.duration ?? liveElapsed;

  // Track streaming → meta transition for resolve animation
  useEffect(() => {
    if (isStreaming) wasStreamingRef.current = true;
    if (wasStreamingRef.current && msg.meta && !resolving) {
      setResolving(true);
    }
  }, [isStreaming, msg.meta]);

  return (
    <div className="message" data-role={msg.role}>
      {!hideRole && (
        <div className="message-role">
          {msg.role}
          {msg.role === "assistant" && (
            <span className="role-stats">
              {toolCount > 0 && <span>{toolCount} tools</span>}
              {duration != null && (
                <span className="role-elapsed">{(duration / 1000).toFixed(1)}s</span>
              )}
            </span>
          )}
        </div>
      )}

      {showThinking && msg.thinking && (
        <>
          {msg.thinkingDuration != null ? (
            <div className="thinking-meta">
              thought for {(msg.thinkingDuration / 1000).toFixed(1)}s
            </div>
          ) : isStreaming && !msg.content && (
            <div className="thinking-meta">
              thinking…
            </div>
          )}
          <div
            className={`message-thinking ${thinkingExpanded ? "expanded" : ""}`}
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
          >
            {msg.thinking}
          </div>
        </>
      )}

      {showToolCalls && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="message-tools">
          {msg.toolCalls.map((tc) => (
            <ToolCallView key={tc.id} tool={tc} defaultExpanded={tc.name === "TodoWrite" ? tc.id === lastTodoId : undefined} showGitEvents={showGitEvents} cwd={cwd} />
          ))}
        </div>
      )}

      {msg.attachments && msg.attachments.length > 0 && (
        <div className="message-images">
          {msg.attachments.map((att, i) => {
            const src = `data:${att.mediaType};base64,${att.data}`;
            const alt = att.name ?? "attachment";
            return (
              <img
                key={i}
                className="message-image"
                src={src}
                alt={alt}
                onClick={() => setLightboxSrc({ src, alt })}
              />
            );
          })}
        </div>
      )}

      {lightboxSrc && (
        <ImageLightbox
          src={lightboxSrc.src}
          alt={lightboxSrc.alt}
          onClose={() => setLightboxSrc(null)}
        />
      )}

      {msg.content && (
        <div className={`message-content${isNew ? " message-content--new" : ""}`}>
          <Markdown content={msg.content} />
        </div>
      )}

      {children}

      {isStreaming && !msg.meta && (
        <div className="message-meta">
          <StreamingCursor feed={streamFeed} />
        </div>
      )}

      {resolving && msg.meta && (
        <div className="message-meta">
          <StreamingCursor resolveText={formatMeta(msg.meta)} onResolved={() => setResolving(false)} />
        </div>
      )}

      {showMeta && msg.meta && !resolving && (
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
});
