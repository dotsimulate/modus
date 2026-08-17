/**
 * Session Turn widget — one turn of a conversation, as a configurable projection.
 *
 * Config: { "type": "session-turn", "id": "t-prose", "blocks": ["text"] }
 *
 * The transcript renders a turn one way: every part of it, stacked vertically,
 * forever. This renders a *projection* of a turn — which parts, and nothing about
 * where they sit. Position is the page layout's business, so three instances
 * declaring `prompt`, `text`, and `tools` compose into a three-zone reading
 * surface, and one instance declaring all three is the same turn as a single
 * column on a phone. The arrangement is data, not another branch in here.
 *
 * Which turn is shown comes from the page context key `turnSeq`, published by
 * `session-turns`. With no ticker on the page the newest turn is shown, which is
 * the right default for a surface that is only ever pointed at the live session.
 *
 * Segments always render in provider order. A turn that thought, called tools,
 * wrote a paragraph, then called more tools reads in that order in every
 * projection — filtering never reorders, it only omits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ensureSubscribed,
  loadOlderSessionHistory,
  loadSessionMessageDetails,
  useSessionHistoryLoadState,
  useSessionState,
} from "../sessionStore";
import { ThinkingBlock } from "../components/ThinkingBlock";
import { ToolCallView } from "../components/ToolCall";
import { ToolCallGroup } from "../components/ToolCallGroup";
import { MessageText } from "../components/MessageText";
import { AttachmentImage } from "../components/AttachmentImage";
import { ImageLightbox } from "../components/ImageLightbox";
import { metaParts } from "../components/providerStats";
import { partitionToolRun, buildLatestMoveToolCallIds } from "../move-tool-view";
import { buildTurns, findTurnBySeq, segmentMessage, tallyToolNames, type ChatTurn } from "../turn-segments";
import type { Message, ToolCall } from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

/** What a projection may contain. Order here is documentation only — the
 *  renderer emits segments in the order the provider produced them. */
export type TurnBlockKind = "prompt" | "thinking" | "text" | "tools" | "meta";

const ALL_BLOCKS: TurnBlockKind[] = ["prompt", "thinking", "text", "tools", "meta"];

type SessionTurnConfig = WidgetBase & {
  type: "session-turn";
  sessionId?: string;
  /** Which parts of the turn this instance draws. Default: all of them. */
  blocks?: TurnBlockKind[];
  /** Height at which the prompt starts scrolling instead of growing. */
  promptMaxHeight?: number;
  /** Show the turn number and timestamp above the projection. */
  header?: boolean;
};

function resolveBlocks(raw: unknown): Set<TurnBlockKind> {
  if (!Array.isArray(raw)) return new Set(ALL_BLOCKS);
  const chosen = raw.filter((value): value is TurnBlockKind => ALL_BLOCKS.includes(value as TurnBlockKind));
  // An unknown-only list means the page meant *something*, and showing the whole
  // turn is a less confusing failure than rendering an empty pane.
  return chosen.length > 0 ? new Set(chosen) : new Set(ALL_BLOCKS);
}

function formatWhen(timestamp?: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function SessionTurnWidget({ config, pageContext }: WidgetProps<SessionTurnConfig>) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;

  const rawTurnSeq = pageContext?.get("turnSeq");
  const requestedSeq = typeof rawTurnSeq === "number" ? rawTurnSeq : null;

  const blocks = useMemo(() => resolveBlocks(config.blocks), [config.blocks]);

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);

  const turns = useMemo(
    () => buildTurns(messages, historyLoad.olderTurnCount),
    [messages, historyLoad.olderTurnCount],
  );

  const turn: ChatTurn | null = useMemo(() => {
    if (requestedSeq == null) return turns[turns.length - 1] ?? null;
    return findTurnBySeq(turns, requestedSeq);
  }, [turns, requestedSeq]);

  // A ticker can address turns older than the loaded window, so an unresolved
  // seq means "page backwards until it appears" rather than "no such turn".
  // Each landed page moves olderTurnCount, which is what re-arms this; when
  // hasMore goes false it stops on its own.
  const missingTurn = requestedSeq != null && !turn;
  const pagingFor = useRef<number | null>(null);
  useEffect(() => {
    if (!sessionId || !missingTurn) {
      pagingFor.current = null;
      return;
    }
    if (!historyLoad.hasMore || historyLoad.loadingOlder || historyLoad.olderError) return;
    // Without this a page that yields nothing new would re-request forever.
    const marker = historyLoad.olderTurnCount;
    if (pagingFor.current === marker) return;
    pagingFor.current = marker;
    void loadOlderSessionHistory(sessionId);
  }, [
    sessionId, missingTurn, historyLoad.hasMore, historyLoad.loadingOlder,
    historyLoad.olderError, historyLoad.olderTurnCount,
  ]);

  const provider = session?.provider ?? session?.agentConfig?.provider;
  const isLiveTurn = !!turn && turns[turns.length - 1]?.key === turn.key;
  const sessionRunning = session?.status === "running" || session?.status === "starting";
  const streaming = isLiveTurn && !!sessionRunning;

  const latestMoveToolCallIds = useMemo(
    () => buildLatestMoveToolCallIds(messages),
    [messages],
  );

  const loadDetails = useCallback((seq: number) => {
    if (sessionId) void loadSessionMessageDetails(sessionId, seq);
  }, [sessionId]);

  const renderToolRun = useCallback((tools: ToolCall[], keyPrefix: string) => (
    // Every run is a line here, including a run of one. That is the whole
    // difference from the transcript, which only folds runs of five or more and
    // only once the turn has landed — so a streaming turn rearranges itself
    // under the reader the instant the result arrives. A card that is already
    // one line per run has nothing to rearrange.
    partitionToolRun(tools).map((partition, index) => {
      const partitionKey = `${keyPrefix}:p:${index}`;
      const rows = (
        <div className="message-tools">
          {partition.tools.map((tool, toolIndex) => (
            <ToolCallView
              key={`${partitionKey}:${toolIndex}:${tool.id}`}
              tool={tool}
              anchorId={`${partitionKey}:${toolIndex}:${tool.id}`}
              sessionId={sessionId}
              latestMoveToolCallIds={latestMoveToolCallIds}
            />
          ))}
        </div>
      );
      // A move that took over its own row drew that row deliberately; burying it
      // under a generic count header would throw the takeover away.
      return partition.moveApi ? (
        <div key={partitionKey}>{rows}</div>
      ) : (
        <ToolCallGroup
          key={partitionKey}
          count={partition.tools.length}
          toolNames={tallyToolNames(partition.tools)}
        >
          {rows}
        </ToolCallGroup>
      );
    })
  ), [sessionId, latestMoveToolCallIds]);

  const renderBody = useCallback((msg: Message) => (
    segmentMessage(msg).map((segment) => {
      if (segment.kind === "text") {
        return blocks.has("text")
          ? <MessageText key={segment.key} messageId={segment.key} role={msg.role} text={segment.text} />
          : null;
      }
      if (segment.kind === "thinking") {
        return blocks.has("thinking")
          ? (
            <ThinkingBlock
              key={segment.key}
              thinking={segment.thinking}
              duration={msg.thinkingDuration}
              isStreaming={streaming}
              hasContent={!!msg.content}
            />
          )
          : null;
      }
      if (segment.kind === "tools") {
        return blocks.has("tools") ? <div key={segment.key}>{renderToolRun(segment.tools, segment.key)}</div> : null;
      }
      // Deferred: the payload is still on the server. It stands in for both
      // thinking and tools, so it appears if either projection wants it.
      const wantsTools = blocks.has("tools") && segment.count > 0;
      const wantsThinking = blocks.has("thinking") && segment.hasThinking;
      if (!wantsTools && !wantsThinking) return null;
      return (
        <ToolCallGroup
          key={segment.key}
          count={wantsTools ? segment.count : 0}
          toolNames={wantsTools ? segment.toolNames : {}}
          hasThinking={wantsThinking}
          deferred
          loading={msg.detailsLoading}
          error={msg.detailsError}
          onLoad={msg.seq != null ? () => loadDetails(msg.seq!) : undefined}
        />
      );
    })
  ), [blocks, streaming, renderToolRun, loadDetails]);

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session) return <WidgetEmptyState>loading session…</WidgetEmptyState>;

  if (!turn) {
    if (missingTurn && (historyLoad.loadingOlder || historyLoad.hasMore)) {
      return <WidgetEmptyState>loading turn {requestedSeq}…</WidgetEmptyState>;
    }
    if (missingTurn) return <WidgetEmptyState>turn not found</WidgetEmptyState>;
    return <WidgetEmptyState>no turns yet</WidgetEmptyState>;
  }

  const stats = blocks.has("meta")
    ? turn.body.flatMap((msg) => metaParts(msg, provider))
    : [];
  const promptStyle = config.promptMaxHeight
    ? { maxHeight: config.promptMaxHeight }
    : undefined;

  return (
    <div className={`session-turn${streaming ? " session-turn--live" : ""}`} data-turn={turn.number}>
      {config.header !== false && (
        <div className="session-turn-head">
          <span className="session-turn-no">{String(turn.number).padStart(2, "0")}</span>
          {streaming && <span className="session-turn-live">live</span>}
          <span className="session-turn-when">
            {formatWhen(turn.prompt?.timestamp ?? turn.body[0]?.timestamp)}
          </span>
        </div>
      )}

      {blocks.has("prompt") && turn.prompt && (
        <div className="session-turn-prompt" style={promptStyle}>
          <MessageText
            messageId={turn.prompt.id}
            role="user"
            text={turn.prompt.content}
          />
          {turn.prompt.attachments && turn.prompt.attachments.length > 0 && (
            <div className="message-images">
              {turn.prompt.attachments.map((attachment, index) => (
                <AttachmentImage
                  key={index}
                  mediaType={attachment.mediaType}
                  data={attachment.data}
                  alt={attachment.name ?? "attachment"}
                  onOpen={(src, alt) => setLightbox({ src, alt })}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <div className="session-turn-body">
        {turn.body.map((msg) => (
          msg.role === "system"
            ? <div key={msg.id} className="system-divider"><span>{msg.content}</span></div>
            : <div key={msg.id} className="session-turn-message">{renderBody(msg)}</div>
        ))}
      </div>

      {stats.length > 0 && (
        <div className="session-turn-meta message-meta">
          {stats.map((part, index) => (
            <span key={`${part.key}:${index}`} className={part.className}>{part.text}</span>
          ))}
        </div>
      )}

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
