import { memo, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { ThinkingBlock } from "./ThinkingBlock";
import type { Message, ToolCall } from "../../../sdk/index";
import { tokenParam } from "../modusClient";
import { ToolCallView } from "./ToolCall";
import { Markdown } from "./Markdown";
import { ImageLightbox } from "./ImageLightbox";
import { StreamingCursor } from "./StreamingCursor";
import { formatProviderTokenUsage } from "./providerStats";
import { CopyMessageButton } from "./CopyMessageButton";
import { AudioArtifact } from "./AudioArtifact";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { addPrompt } from "../promptCache";
import { isCodexProvider } from "../tools";

function artifactSrc(url: string): string {
  const tp = tokenParam();
  if (!tp) return url;
  return `${url}?${tp}`;
}

function base64ToBlobUrl(data: string, mediaType: string): string {
  const binary = atob(data);
  const chunkSize = 8192;
  const chunks: ArrayBuffer[] = [];
  for (let offset = 0; offset < binary.length; offset += chunkSize) {
    const slice = binary.slice(offset, offset + chunkSize);
    const bytes = new Uint8Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
      bytes[i] = slice.charCodeAt(i);
    }
    chunks.push(bytes.buffer);
  }
  return URL.createObjectURL(new Blob(chunks, { type: mediaType }));
}

function AttachmentImage({
  mediaType,
  data,
  alt,
  onOpen,
}: {
  mediaType: string;
  data: string;
  alt: string;
  onOpen: (src: string, alt: string) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    try {
      url = base64ToBlobUrl(data, mediaType);
      setSrc(url);
    } catch {
      setSrc(null);
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [data, mediaType]);

  if (!src) {
    return <div className="message-image message-image--unavailable">{alt}</div>;
  }

  return (
    <img
      className="message-image"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onClick={() => onOpen(src, alt)}
    />
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
  onBranch?: (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => void;
  onStopTask?: (taskId: string) => void;
  children?: ReactNode;
};

function formatContextPct(meta: Message["meta"]): string | null {
  if (!meta?.contextWindow) return null;
  if (meta.contextPercent != null) return `${Math.round(meta.contextPercent)}%`;
  if (meta.contextTokensUsed == null || meta.contextTokensUsed <= 0) return null;
  return `${Math.round((meta.contextTokensUsed / meta.contextWindow) * 100)}%`;
}

function formatTokensPerSecond(meta: Message["meta"], provider?: string): string | null {
  if (isCodexProvider(provider)) return null;
  if (!meta?.outputTokens || !meta.duration || meta.duration <= 0) return null;
  const rate = meta.outputTokens / (meta.duration / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)} tok/s`;
}

function formatMeta(meta: Message["meta"], provider?: string): string {
  if (!meta) return "";
  const parts: string[] = [];
  if (meta.model) parts.push(meta.model);
  if (meta.cost != null) parts.push(`$${meta.cost.toFixed(4)}`);
  if (meta.turns != null) parts.push(`${meta.turns} turns`);
  const usage = formatProviderTokenUsage(provider, meta.inputTokens, meta.outputTokens);
  if (usage) parts.push(usage);
  const tokensPerSecond = formatTokensPerSecond(meta, provider);
  if (tokensPerSecond) parts.push(tokensPerSecond);
  const ctx = formatContextPct(meta);
  if (ctx) parts.push(`${ctx} ctx`);
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
    return <AudioArtifact key={artifact.id} artifact={artifact} autoPlay />;
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
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const wasStreamingRef = useRef(false);
  const { open: openContextMenu, portal: contextMenuPortal } = useContextMenu();

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const selection = window.getSelection();
    const selectedText = selection?.toString() ?? "";
    if (!selectedText.trim()) return; // let the browser default menu handle it
    const items: ContextMenuItem[] = [
      {
        kind: "action",
        label: "Copy",
        onClick: () => {
          void navigator.clipboard.writeText(selectedText).catch(() => {});
        },
      },
      { kind: "separator" },
      {
        kind: "action",
        label: "Save to prompt cache",
        onClick: () => {
          addPrompt(selectedText);
          setSavedToast(true);
          setTimeout(() => setSavedToast(false), 1400);
        },
      },
    ];
    openContextMenu(e, items);
  }, [openContextMenu]);
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
        <ThinkingBlock
          thinking={msg.thinking}
          duration={msg.thinkingDuration}
          isStreaming={isStreaming}
          hasContent={!!msg.content}
        />
      )}

      {msg.content && (
        <div
          className={`message-content${isNew ? " message-content--new" : ""}`}
          onContextMenu={handleContextMenu}
        >
          <Markdown content={msg.content} />
          {savedToast && (
            <div className="prompt-cache-toast">saved to prompt cache</div>
          )}
        </div>
      )}
      {contextMenuPortal}

      {showToolCalls && msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="message-tools">
          {msg.toolCalls.map((tc, index) => (
            <ToolCallView
              key={`${msg.id}:${index}:${tc.id}`}
              tool={tc}
              anchorId={`${msg.id}:${index}:${tc.id}`}
              defaultExpanded={tc.name === "TodoWrite" ? tc.id === lastTodoId : undefined}
              showGitEvents={showGitEvents}
              cwd={cwd}
              onStopTask={onStopTask}
            />
          ))}
        </div>
      )}

      {msg.attachments && msg.attachments.length > 0 && (
        <div className="message-images">
          {msg.attachments.map((att, i) => {
            const alt = att.name ?? "attachment";
            return (
              <AttachmentImage
                key={i}
                mediaType={att.mediaType}
                data={att.data}
                alt={alt}
                onOpen={(src, imageAlt) => setLightboxSrc({ src, alt: imageAlt })}
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

      {msg.artifacts && msg.artifacts.length > 0 && (
        <div className="message-artifacts">
          {msg.artifacts.map((artifact) => renderArtifact(
            artifact,
            (src, alt) => setLightboxSrc({ src, alt }),
          ))}
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
          {formatTokensPerSecond(msg.meta, provider) && (
            <span className="meta-tokens">{formatTokensPerSecond(msg.meta, provider)}</span>
          )}
          {formatContextPct(msg.meta) && (
            <span className="meta-context">{formatContextPct(msg.meta)} ctx</span>
          )}
          {msg.meta.duration != null && (
            <span className="meta-duration">
              {msg.timestamp
                ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                : null}
              {msg.timestamp && <span className="meta-duration-elapsed"> ({(msg.meta.duration / 1000).toFixed(1)}s)</span>}
              {!msg.timestamp && `${(msg.meta.duration / 1000).toFixed(1)}s`}
            </span>
          )}
          <CopyMessageButton msg={msg} />
        </div>
      )}

    </div>
  );
});
