import { memo, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { ThinkingBlock } from "./ThinkingBlock";
import type { Message, ToolCall, ToolCallDisplayMode } from "../../../sdk/index";
import { mimeToPreviewKind } from "../../../sdk/index";
import { tokenParam } from "../modusClient";
import { backendUrl } from "../backendTarget";
import { ToolCallView } from "./ToolCall";
import { ToolCallGroup, TOOL_RUN_GROUP_MIN } from "./ToolCallGroup";
import { ImageLightbox } from "./ImageLightbox";
import { AttachmentImage } from "./AttachmentImage";
import { StreamingCursor } from "./StreamingCursor";
import { metaParts } from "./providerStats";
import { MessageText } from "./MessageText";
import { CopyMessageButton } from "./CopyMessageButton";
import { AudioArtifact } from "./AudioArtifact";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";
import { addPrompt } from "../promptCache";
import { partitionToolRun } from "../move-tool-view";
import { segmentContentBlocks, tallyToolNames } from "../turn-segments";
import { isTodoTool } from "../tool-names";

/**
 * Absolute URL for a session artifact.
 *
 * Artifact urls are stored root-relative (`/api/sessions/.../artifacts/3`), which
 * only resolves when the document is served by the harness. The desktop shell is
 * served from tauri.localhost and talks to the backend on 127.0.0.1, so a
 * relative url there hits Tauri's asset server and comes back as the SPA's
 * index.html — a broken image, or "bad content-type: text/html" from the audio
 * player. backendUrl() is a no-op for same-origin browsers, where apiBase is "".
 */
function artifactSrc(url: string): string {
  const absolute = backendUrl(url);
  const tp = tokenParam();
  if (!tp) return absolute;
  return `${absolute}${absolute.includes("?") ? "&" : "?"}${tp}`;
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
  toolCallDisplay?: ToolCallDisplayMode;
  showGitEvents?: boolean;
  cwd?: string | null;
  lastTodoId?: string;
  streamFeed?: string;
  onBranch?: (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => void;
  onStopTask?: (taskId: string) => void;
  onLoadDetails?: () => void | Promise<void>;
  children?: ReactNode;
  sessionId?: string | null;
  latestMoveToolCallIds?: ReadonlyMap<string, string>;
};

function renderArtifact(
  artifact: NonNullable<Message["artifacts"]>[number],
  openImage: (src: string, alt: string) => void,
) {
  // One classifier shared with the preview shelf, so an artifact renders the
  // same way wherever it surfaces. Prefix matching here used to miss PDFs and
  // any text type other than exactly "text/plain".
  const kind = mimeToPreviewKind(artifact.mime);

  if (kind === "image") {
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
  if (kind === "audio") {
    return <AudioArtifact key={artifact.id} artifact={artifact} autoPlay />;
  }
  if (kind === "video") {
    return (
      <div key={artifact.id} className="message-media-card">
        <div className="message-media-label">{artifact.name}</div>
        <video className="message-video" controls preload="metadata" src={artifactSrc(artifact.url)} />
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <div key={artifact.id} className="message-media-card">
        <div className="message-media-label">{artifact.name}</div>
        <iframe
          className="message-pdf"
          src={artifactSrc(artifact.url)}
          title={artifact.name}
          // A PDF is untrusted document content; keep it from acquiring an
          // origin or navigating the app that embedded it.
          sandbox=""
        />
        {/* The embedded viewer depends on the webview's PDF support, which
            differs between the desktop shell and a browser. Keep the link so
            this can never be worse than the plain download it replaced. */}
        <a
          className="message-artifact-link"
          href={artifactSrc(artifact.url)}
          target="_blank"
          rel="noreferrer"
        >
          open artifact
        </a>
      </div>
    );
  }
  if (kind === "text" && artifact.previewText) {
    return (
      <div key={artifact.id} className="message-media-card">
        <div className="message-media-label">{artifact.name}</div>
        <div className="message-artifact-text">{artifact.previewText}</div>
        <a
          className="message-artifact-link"
          href={artifactSrc(artifact.url)}
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
      href={artifactSrc(artifact.url)}
      target="_blank"
      rel="noreferrer"
    >
      {artifact.name}
    </a>
  );
}

export const MessageBubble = memo(function MessageBubble({ msg, provider, isNew = false, isStreaming, hideRole = false, showThinking = true, showMeta = true, toolCallDisplay = "collapsed", showGitEvents = true, cwd, lastTodoId, streamFeed, onBranch, onStopTask, onLoadDetails, children, sessionId, latestMoveToolCallIds }: Props) {
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
  const parts = metaParts(msg, provider);
  // An empty resolve target never reveals, so StreamingCursor would never call
  // onResolved and the row would scramble forever.
  const resolveText = parts.map((part) => part.text).join("  ");
  const showToolCalls = toolCallDisplay !== "hidden";
  // Group only once the turn has landed. While it streams you want to watch
  // each call arrive; collapsing mid-turn would hide the work in progress.
  // "expanded" already means "show me everything", so it opts out.
  const groupRuns = toolCallDisplay === "collapsed" && !isStreaming;

  const renderToolRun = (tools: ToolCall[], keyPrefix: string) => (
    <div className="message-tools" key={keyPrefix}>
      {tools.map((tc, index) => (
        <ToolCallView
          key={`${keyPrefix}:${index}:${tc.id}`}
          tool={tc}
          anchorId={`${keyPrefix}:${index}:${tc.id}`}
          defaultExpanded={toolCallDisplay === "expanded" ? true : isTodoTool(tc.name) ? tc.id === lastTodoId : undefined}
          showGitEvents={showGitEvents}
          cwd={cwd}
          onStopTask={onStopTask}
          sessionId={sessionId}
          latestMoveToolCallIds={latestMoveToolCallIds}
          artifacts={msg.artifacts}
        />
      ))}
    </div>
  );

  const renderGroupedToolRun = (tools: ToolCall[], keyPrefix: string) => (
    partitionToolRun(tools).map((partition, index) => {
      const partitionKey = `${keyPrefix}:partition:${index}`;
      const rows = renderToolRun(partition.tools, partitionKey);
      return !partition.moveApi && partition.tools.length >= TOOL_RUN_GROUP_MIN ? (
        <ToolCallGroup
          key={partitionKey}
          count={partition.tools.length}
          toolNames={tallyToolNames(partition.tools)}
        >
          {rows}
        </ToolCallGroup>
      ) : rows;
    })
  );

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

      {msg.contentBlocks?.length ? (
        <>
          {segmentContentBlocks(msg.id, msg.contentBlocks).map((segment) => {
            if (segment.kind === "text") {
              return (
                <MessageText
                  key={segment.key}
                  messageId={segment.key}
                  role={msg.role}
                  text={segment.text}
                  isNew={isNew}
                  onContextMenu={handleContextMenu}
                />
              );
            }
            if (segment.kind === "thinking") {
              return showThinking ? (
                <ThinkingBlock
                  key={segment.key}
                  thinking={segment.thinking}
                  duration={msg.thinkingDuration}
                  isStreaming={isStreaming}
                  hasContent={!!msg.content}
                />
              ) : null;
            }
            if (segment.kind === "tools") {
              if (!showToolCalls) return null;
              const rows = renderToolRun(segment.tools, segment.key);
              return groupRuns ? renderGroupedToolRun(segment.tools, segment.key) : rows;
            }
            const visibleToolCount = showToolCalls ? segment.count : 0;
            return onLoadDetails && (showThinking && segment.hasThinking || visibleToolCount > 0) ? (
              <ToolCallGroup
                key={segment.key}
                count={visibleToolCount}
                toolNames={showToolCalls ? segment.toolNames : {}}
                hasThinking={showThinking && segment.hasThinking}
                deferred
                loading={msg.detailsLoading}
                error={msg.detailsError}
                onLoad={onLoadDetails}
              />
            ) : null;
          })}
        </>
      ) : (
        <>
          {msg.detailsDeferred && onLoadDetails && (showThinking || showToolCalls) && (
            <ToolCallGroup
              count={showToolCalls ? msg.deferredToolCallCount ?? 0 : 0}
              toolNames={{}}
              hasThinking={showThinking && !!msg.deferredHasThinking}
              deferred
              loading={msg.detailsLoading}
              error={msg.detailsError}
              onLoad={onLoadDetails}
            />
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
            <MessageText
              messageId={msg.id}
              role={msg.role}
              text={msg.content}
              isNew={isNew}
              onContextMenu={handleContextMenu}
            />
          )}
          {showToolCalls && msg.toolCalls && msg.toolCalls.length > 0 && (
            groupRuns
              ? renderGroupedToolRun(msg.toolCalls, `${msg.id}:flat`)
              : renderToolRun(msg.toolCalls, `${msg.id}:flat`)
          )}
        </>
      )}
      {savedToast && (
        <div className="prompt-cache-toast">saved to prompt cache</div>
      )}
      {contextMenuPortal}

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
          {liveElapsed != null && (
            <span className="meta-duration meta-elapsed-live">{(liveElapsed / 1000).toFixed(0)}s</span>
          )}
        </div>
      )}

      {resolving && resolveText && (
        <div className="message-meta">
          <StreamingCursor resolveText={resolveText} onResolved={() => setResolving(false)} />
        </div>
      )}

      {showMeta && parts.length > 0 && !(resolving && resolveText) && (
        <div className="message-meta">
          {parts.map((part) => (
            <span key={part.key} className={part.className}>{part.text}</span>
          ))}
          <CopyMessageButton msg={msg} />
        </div>
      )}

    </div>
  );
});
