import { memo, useState, useEffect, useRef, type ReactNode } from "react";
import type { Message, ToolCall } from "../api";
import { tokenParam } from "../api/_fetch";
import { ToolCallView } from "./ToolCall";
import { Markdown } from "./Markdown";
import { ImageLightbox } from "./ImageLightbox";
import { StreamingCursor } from "./StreamingCursor";
import { formatProviderTokenUsage } from "./providerStats";
import { CopyMessageButton } from "./CopyMessageButton";

function artifactSrc(url: string): string {
  const tp = tokenParam();
  if (!tp) return url;
  return `${url}?${tp}`;
}

const _playedArtifacts = new Set<number>();

function AudioArtifact({ artifact }: { artifact: NonNullable<Message["artifacts"]>[number] }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && !_playedArtifacts.has(artifact.id)) {
      _playedArtifacts.add(artifact.id);
      ref.current.play().catch(() => {});
    }
  }, [artifact.id]);
  return (
    <div className="message-media-card">
      <div className="message-media-label">{artifact.name}</div>
      <audio ref={ref} className="message-audio" controls preload="auto" src={artifactSrc(artifact.url)} />
    </div>
  );
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
 *  Uses msg.timestamp (from event created_at) so it survives refresh. */
function useElapsed(active: boolean, startTime?: number): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null);
  const startRef = useRef<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (active) {
      if (!startRef.current) startRef.current = startTime ?? Date.now();
      const tick = () => setElapsed(Date.now() - startRef.current);
      tick();
      intervalRef.current = setInterval(tick, 1000);
      return () => clearInterval(intervalRef.current);
    }
    // Keep showing last elapsed after streaming ends (before meta arrives)
  }, [active, startTime]);

  return elapsed;
}

type Props = {
  msg: Message;
  provider?: string;
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
  onBranch?: (seq: number, prefill?: string) => void;
  onStopTask?: (taskId: string) => void;
  children?: ReactNode;
};

function formatMeta(meta: Message["meta"], provider?: string): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (meta.cost != null) parts.push(`$${meta.cost.toFixed(4)}`);
  if (meta.turns != null) parts.push(`${meta.turns} turns`);
  const usage = formatProviderTokenUsage(provider, meta.inputTokens, meta.outputTokens);
  if (usage) parts.push(usage);
  if (meta.duration != null) parts.push(`${(meta.duration / 1000).toFixed(1)}s`);
  return parts.join("  ");
}

function renderArtifact(
  artifact: NonNullable<Message["artifacts"]>[number],
  openImage: (src: string, alt: string) => void,
) {
  if (artifact.mime.startsWith("image/")) {
    return (
      <img
        key={artifact.id}
        className="message-image"
        src={artifactSrc(artifact.url)}
        alt={artifact.name}
        onClick={() => openImage(artifactSrc(artifact.url), artifact.name)}
      />
    );
  }
  if (artifact.mime.startsWith("audio/")) {
    return <AudioArtifact key={artifact.id} artifact={artifact} />;
  }
  if (artifact.mime.startsWith("video/")) {
    return (
      <div key={artifact.id} className="message-media-card">
        <div className="message-media-label">{artifact.name}</div>
        <video className="message-video" controls preload="metadata" src={artifactSrc(artifact.url)} />
      </div>
    );
  }
  if (artifact.mime === "text/plain" && artifact.previewText) {
    return (
      <div key={artifact.id} className="message-media-card">
        <div className="message-media-label">{artifact.name}</div>
        <div className="message-artifact-text">{artifact.previewText}</div>
        <a
          className="message-artifact-link"
          href={artifact.url}
          target="_blank"
          rel="noreferrer"
        >
          open artifact
        </a>
      </div>
    );
  }
  return (
    <a
      key={artifact.id}
      className="message-artifact-link"
      href={artifact.url}
      target="_blank"
      rel="noreferrer"
    >
      {artifact.name}
    </a>
  );
}


export const MessageBubble = memo(function MessageBubble({ msg, provider, isNew = false, isStreaming, hideRole = false, showThinking = true, showMeta = true, showToolCalls = true, showGitEvents = true, cwd, lastTodoId, streamFeed, onBranch, onStopTask, children }: Props) {
  void onBranch;
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const wasStreamingRef = useRef(false);
  const toolCount = countAllTools(msg.toolCalls);
  const liveElapsed = useElapsed(isStreaming && !msg.meta, msg.timestamp);
  const duration = msg.meta?.duration ?? liveElapsed;
  const usageText = formatProviderTokenUsage(provider, msg.meta?.inputTokens, msg.meta?.outputTokens);

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
            <ToolCallView key={tc.id} tool={tc} defaultExpanded={tc.name === "TodoWrite" ? tc.id === lastTodoId : undefined} showGitEvents={showGitEvents} cwd={cwd} onStopTask={onStopTask} />
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

      {msg.artifacts && msg.artifacts.length > 0 && (
        <div className="message-artifacts">
          {msg.artifacts.map((artifact) => renderArtifact(
            artifact,
            (src, alt) => setLightboxSrc({ src, alt }),
          ))}
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
          <StreamingCursor resolveText={formatMeta(msg.meta, provider)} onResolved={() => setResolving(false)} />
        </div>
      )}

      {showMeta && msg.meta && !resolving && (
        <div className="message-meta">
          {msg.meta.model && <span>{msg.meta.model}</span>}
          {msg.meta.cost != null && (
            <span>${msg.meta.cost.toFixed(4)}</span>
          )}
          {msg.meta.turns != null && <span>{msg.meta.turns} turns</span>}
          {usageText && (
            <span className="meta-tokens">
              {usageText}
            </span>
          )}
          {msg.meta.duration != null && (
            <span className="meta-duration">{(msg.meta.duration / 1000).toFixed(1)}s</span>
          )}
          <CopyMessageButton msg={msg} />
        </div>
      )}

    </div>
  );
});
