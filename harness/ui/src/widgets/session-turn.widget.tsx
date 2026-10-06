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
 * Which turn is shown comes from the page context key `turnNumber`, with
 * `turnSeq` retained as a compatibility hint for older authored pages. The
 * compact navigator and optional `session-turns` rail publish both. With no selection the newest turn is shown, which is the right default
 * for a surface that is only ever pointed at the live session.
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
import { partitionToolRun } from "../move-tool-view";
import { useLatestMoveToolCallIds } from "../hooks/useLatestMoveToolCallIds";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { useInterfaceSettings } from "../useInterfaceSettings";
import {
  applyInterfaceSettings,
  projectChatOverrideConfig,
  projectChatOverrideEnabled,
  readDeviceInterfaceSettings,
  writeDeviceInterfaceSettings,
} from "../interface-settings";
import {
  accumulateTurnScrollThrough,
  buildTurnNavigationEntries,
  canConsumeDirectionalScroll,
  describeTurnActivity,
  isNearTurnBottom,
  resolveTurnNavigation,
  shouldAutoScrollTurn,
  type TurnNavigationEntry,
  type TurnScrollThroughProgress,
} from "../turn-card-state";
import { buildTurns, findTurnBySeq, segmentMessage, streamingTailSegments, tallyToolNames, type ChatTurn } from "../turn-segments";
import type { Message, SessionTurnIndexEntry, ToolCall } from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

const EMPTY_TURN_MESSAGES: Message[] = [];

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
  /** Show the compact previous/next navigator. Default: true. */
  navigation?: boolean;
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

function normalizedWheelDelta(event: React.WheelEvent<HTMLDivElement>): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * event.currentTarget.clientHeight;
  return event.deltaY;
}

function nestedScrollSurfaceCanConsume(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  let element = target instanceof Element ? target : null;
  while (element && element !== boundary) {
    if (element instanceof HTMLElement) {
      const overflowY = window.getComputedStyle(element).overflowY;
      if (/^(auto|scroll|overlay)$/.test(overflowY)
        && canConsumeDirectionalScroll(element, deltaY)) return true;
    }
    element = element.parentElement;
  }
  return false;
}

function RevealedTurnText({ messageId, role, text, revealOnMount, onReveal }: {
  messageId: string;
  role: Message["role"];
  text: string;
  revealOnMount: boolean;
  onReveal: () => void;
}) {
  const [enteredAsNew] = useState(revealOnMount);
  const previousTextRef = useRef(text);

  useEffect(() => {
    const changed = previousTextRef.current !== text;
    previousTextRef.current = text;
    if (enteredAsNew || changed) onReveal();
  }, [text, enteredAsNew, onReveal]);

  return (
    <div className={`session-turn-revealed-text${enteredAsNew ? " session-turn-revealed-text--new" : ""}`}>
      <MessageText
        messageId={messageId}
        role={role}
        text={text}
        revealText={enteredAsNew}
      />
    </div>
  );
}

export default function SessionTurnWidget({ config, pageContext }: WidgetProps<SessionTurnConfig>) {
  const { activeUserProfile, activeUP, refreshUserProfiles } = useProfiles();
  const interfaceSettings = useInterfaceSettings(activeUP?.interface);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLiveRef = useRef(true);
  const scrolledTurnRef = useRef<string | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollThroughLockedRef = useRef(false);
  const scrollThroughLandingRef = useRef<"top" | "bottom" | null>(null);
  const scrollThroughLastWheelRef = useRef(0);
  const scrollThroughProgressRef = useRef<TurnScrollThroughProgress>({ direction: null, distance: 0 });
  const [viewedTurnKey, setViewedTurnKey] = useState<string | null>(null);
  const scrollThrough = interfaceSettings.chat.scrollThroughTurns;
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;

  const turnSessionId = pageContext?.get("turnSessionId");
  const selectionMatchesSession = typeof turnSessionId !== "string" || turnSessionId === sessionId;
  const rawTurnNumber = pageContext?.get("turnNumber");
  const requestedNumber = selectionMatchesSession && typeof rawTurnNumber === "number" ? rawTurnNumber : null;
  const rawTurnSeq = pageContext?.get("turnSeq");
  const requestedSeq = selectionMatchesSession && requestedNumber == null && typeof rawTurnSeq === "number" ? rawTurnSeq : null;

  const blocks = useMemo(() => resolveBlocks(config.blocks), [config.blocks]);

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const messages = session?.messages ?? EMPTY_TURN_MESSAGES;

  const [indexedTurns, setIndexedTurns] = useState<{
    sessionId: string;
    entries: SessionTurnIndexEntry[];
  } | null>(null);
  const messageCount = messages.length;
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    const controller = new AbortController();
    modus.getSessionTurnIndex(sessionId, { signal: controller.signal })
      .then((result) => {
        if (active) setIndexedTurns({ sessionId, entries: result.turns });
      })
      .catch(() => {
        // Loaded turns are a complete fallback for the compact navigator. An
        // index failure only means it cannot jump to history not fetched yet.
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, messageCount]);

  const turnIndex = useMemo(
    () => indexedTurns?.sessionId === sessionId ? indexedTurns.entries : [],
    [indexedTurns, sessionId],
  );

  const turns = useMemo(
    () => buildTurns(messages, historyLoad.olderTurnCount),
    [messages, historyLoad.olderTurnCount],
  );

  const turn: ChatTurn | null = useMemo(() => {
    if (requestedNumber != null) return turns.find((candidate) => candidate.number === requestedNumber) ?? null;
    if (requestedSeq != null) return findTurnBySeq(turns, requestedSeq);
    return turns[turns.length - 1] ?? null;
  }, [turns, requestedNumber, requestedSeq]);

  // A ticker can address turns older than the loaded window, so an unresolved
  // seq means "page backwards until it appears" rather than "no such turn".
  // Each landed page moves olderTurnCount, which is what re-arms this; when
  // hasMore goes false it stops on its own.
  const missingTurn = (requestedNumber != null || requestedSeq != null) && !turn;
  const pagingFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || !missingTurn) {
      pagingFor.current = null;
      return;
    }
    if (!historyLoad.hasMore || historyLoad.loadingOlder || historyLoad.olderError) return;
    // Without this a page that yields nothing new would re-request forever.
    const marker = `${requestedNumber ?? requestedSeq}:${historyLoad.olderTurnCount}`;
    if (pagingFor.current === marker) return;
    pagingFor.current = marker;
    void loadOlderSessionHistory(sessionId);
  }, [
    sessionId, missingTurn, historyLoad.hasMore, historyLoad.loadingOlder,
    historyLoad.olderError, historyLoad.olderTurnCount, requestedNumber, requestedSeq,
  ]);

  const provider = session?.provider ?? session?.agentConfig?.provider;
  const isLiveTurn = !!turn && turns[turns.length - 1]?.key === turn.key;
  const sessionRunning = session?.status === "running" || session?.status === "starting";
  const streaming = isLiveTurn && !!sessionRunning;
  const animateNewText = isLiveTurn && viewedTurnKey === turn?.key;

  const navigationEntries = useMemo(
    () => buildTurnNavigationEntries(turnIndex, turns),
    [turnIndex, turns],
  );
  const navigation = useMemo(
    () => resolveTurnNavigation(navigationEntries, turn),
    [navigationEntries, turn],
  );
  const activity = useMemo(
    () => blocks.has("text")
      ? describeTurnActivity(turn, streaming ? session?.status : undefined)
      : null,
    [blocks, turn, streaming, session?.status],
  );

  // Existing blocks are established before a turn is marked viewed. Switching
  // turns therefore paints complete text; only blocks/appendages arriving on a
  // later render of the already-viewed live turn get the typed reveal.
  useEffect(() => {
    const turnKey = turn?.key ?? null;
    const frame = requestAnimationFrame(() => setViewedTurnKey(turnKey));
    return () => cancelAnimationFrame(frame);
  }, [turn?.key]);

  useEffect(() => {
    scrollThroughProgressRef.current = { direction: null, distance: 0 };
    scrollThroughLastWheelRef.current = 0;
    // A crossing locks only the turn it started on. Once the selected turn has
    // actually rendered, continued wheel momentum may earn another crossing.
    scrollThroughLockedRef.current = false;
  }, [turn?.key]);

  const requestLatestFollow = useCallback(() => {
    if (!isLiveTurn || !followLiveRef.current || scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const element = scrollRef.current;
      if (!element || !shouldAutoScrollTurn(
        isLiveTurn,
        followLiveRef.current,
        element.clientHeight,
        element.scrollHeight,
      )) return;
      element.scrollTop = element.scrollHeight;
    });
  }, [isLiveTurn]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  // A newly selected completed turn starts at its prompt; selecting the live
  // edge starts at the latest response. From there live growth follows only
  // while the reader remains near the bottom, so manually scrolling upward is
  // respected rather than fought on every token.
  useEffect(() => {
    const turnKey = turn?.key ?? null;
    if (scrolledTurnRef.current === turnKey) return;
    if (!turnKey) return;
    scrolledTurnRef.current = turnKey;
    const landing = scrollThroughLandingRef.current;
    scrollThroughLandingRef.current = null;
    followLiveRef.current = landing !== "top";
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTop = landing === "bottom"
        ? element.scrollHeight
        : landing === "top"
          ? 0
          : streaming
            ? element.scrollHeight
            : 0;
    });
    return () => cancelAnimationFrame(frame);
  }, [turn?.key, streaming]);

  useEffect(() => {
    if (streaming) requestLatestFollow();
  }, [turn, activity, streaming, requestLatestFollow]);

  const handleScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    followLiveRef.current = isNearTurnBottom(
      element.scrollTop,
      element.clientHeight,
      element.scrollHeight,
    );
  }, []);

  const selectTurn = useCallback((entry: TurnNavigationEntry | null) => {
    pageContext?.set("turnSessionId", sessionId);
    pageContext?.set("turnNumber", entry?.number ?? null);
    pageContext?.set("turnSeq", entry?.seq ?? null);
  }, [pageContext, sessionId]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!scrollThrough || !pageContext || !navigation) return;

    const deltaY = normalizedWheelDelta(event);
    if (nestedScrollSurfaceCanConsume(event.target, event.currentTarget, deltaY)) {
      scrollThroughProgressRef.current = { direction: null, distance: 0 };
      scrollThroughLastWheelRef.current = 0;
      return;
    }

    const now = performance.now();
    if (scrollThroughLockedRef.current) return;

    if (now - scrollThroughLastWheelRef.current > 220) {
      scrollThroughProgressRef.current = { direction: null, distance: 0 };
    }
    scrollThroughLastWheelRef.current = now;

    const element = event.currentTarget;
    const result = accumulateTurnScrollThrough(
      scrollThroughProgressRef.current,
      deltaY,
      {
        atTop: element.scrollTop <= 1,
        atBottom: element.scrollHeight - element.scrollTop - element.clientHeight <= 1,
        canPrevious: navigation.previous != null,
        canNext: navigation.next != null,
      },
    );
    scrollThroughProgressRef.current = result.progress;
    if (!result.consumed) return;
    if (!result.navigate) return;

    scrollThroughLockedRef.current = true;
    if (result.navigate === "previous") {
      if (navigation.previous != null) {
        scrollThroughLandingRef.current = "bottom";
        selectTurn(navigation.previous);
      }
      return;
    }
    if (navigation.next != null) {
      scrollThroughLandingRef.current = "top";
      selectTurn(navigation.nextIsLatest ? null : navigation.next);
    }
  }, [navigation, pageContext, scrollThrough, selectTurn]);

  const toggleScrollThrough = useCallback(() => {
    scrollThroughProgressRef.current = { direction: null, distance: 0 };
    scrollThroughLockedRef.current = false;
    const next = {
      ...interfaceSettings,
      chat: { ...interfaceSettings.chat, scrollThroughTurns: !scrollThrough },
    };
    applyInterfaceSettings(next);

    if (projectChatOverrideEnabled(activeUP?.interface) && activeUserProfile) {
      void modus.patchUserProfileUiConfig(activeUserProfile, {
        interface: {
          chat: {
            ...(activeUP?.interface?.chat ?? {}),
            ...projectChatOverrideConfig(next),
          },
        },
      }).then(refreshUserProfiles).catch(() => {});
      return;
    }

    const defaults = readDeviceInterfaceSettings();
    writeDeviceInterfaceSettings({
      ...defaults,
      chat: { ...defaults.chat, scrollThroughTurns: !scrollThrough },
    });
  }, [activeUP?.interface, activeUserProfile, interfaceSettings, refreshUserProfiles, scrollThrough]);

  const latestMoveToolCallIds = useLatestMoveToolCallIds(messages);

  const loadDetails = useCallback((seq: number) => {
    if (sessionId) void loadSessionMessageDetails(sessionId, seq);
  }, [sessionId]);

  const renderToolRun = useCallback((tools: ToolCall[], keyPrefix: string) => (
    // Every run is a line here, including a run of one. That is the whole
    // difference from the transcript, which only offers grouping for runs of
    // five or more once the turn has landed. Focus offers it from the start.
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

  const renderBody = useCallback((msg: Message, streamingMessage: boolean) => (
    [...segmentMessage(msg), ...(streamingMessage ? streamingTailSegments(msg) : [])].map((segment) => {
      if (segment.kind === "text") {
        return blocks.has("text")
          ? (
            <RevealedTurnText
              key={segment.key}
              messageId={segment.key}
              role={msg.role}
              text={segment.text}
              revealOnMount={animateNewText}
              onReveal={requestLatestFollow}
            />
          )
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
        if (blocks.has("tools")) return <div key={segment.key}>{renderToolRun(segment.tools, segment.key)}</div>;
        if (!blocks.has("text") || segment.tools.length === 0) return null;
        const active = streaming && segment.tools.some((tool) => tool.status === "running");
        return (
          <div
            key={segment.key}
            className={`session-turn-tool-break${active ? " session-turn-tool-break--active" : ""}`}
            role="separator"
            aria-label={`${segment.tools.length} tool ${segment.tools.length === 1 ? "call" : "calls"}`}
          >
            <span className="session-turn-tool-break-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        );
      }
      // Deferred: the payload is still on the server. It stands in for both
      // thinking and tools, so it appears if either projection wants it.
      const wantsTools = blocks.has("tools") && segment.count > 0;
      const wantsThinking = blocks.has("thinking") && segment.hasThinking;
      if (!wantsTools && !wantsThinking && blocks.has("text") && segment.count > 0) {
        return (
          <div
            key={segment.key}
            className="session-turn-tool-break"
            role="separator"
            aria-label={`${segment.count} tool ${segment.count === 1 ? "call" : "calls"}`}
          >
            <span className="session-turn-tool-break-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        );
      }
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
  ), [blocks, streaming, animateNewText, requestLatestFollow, renderToolRun, loadDetails]);

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session) return <WidgetEmptyState>loading session…</WidgetEmptyState>;

  if (!turn) {
    if (missingTurn && (historyLoad.loadingOlder || historyLoad.hasMore)) {
      return <WidgetEmptyState>loading turn {requestedNumber ?? requestedSeq}…</WidgetEmptyState>;
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
    <div
      ref={scrollRef}
      className={`session-turn${scrollThrough ? " session-turn--scroll-through" : ""}`}
      data-turn={turn.number}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      <div className="session-turn-shell">
        <div key={turn.key} className="session-turn-center">
          {config.header !== false && (
            <div className="session-turn-head">
              <span className="session-turn-no">{String(turn.number).padStart(2, "0")}</span>
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
            {turn.body.map((msg, index) => (
              msg.role === "system"
                ? <div key={msg.id} className="system-divider"><span>{msg.content}</span></div>
                : (
                  <div key={msg.id} className="session-turn-message">
                    {renderBody(msg, streaming && index === turn.body.length - 1)}
                  </div>
                )
            ))}
            {activity && (
              <div
                className={`session-turn-activity session-turn-activity--${activity.phase}`}
                role="status"
                aria-live="polite"
              >
                <span className="session-turn-activity-signal" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="session-turn-activity-label">{activity.label}</span>
                {activity.detail && <span className="session-turn-activity-detail">{activity.detail}</span>}
                {activity.activeCount && activity.activeCount > 1 && (
                  <span className="session-turn-activity-count">+{activity.activeCount - 1}</span>
                )}
              </div>
            )}
          </div>

          {stats.length > 0 && (
            <div className="session-turn-meta message-meta">
              {stats.map((part, index) => (
                <span key={`${part.key}:${index}`} className={part.className}>{part.text}</span>
              ))}
            </div>
          )}
        </div>

        {config.navigation !== false && pageContext && navigation && navigationEntries.length > 1 && (
          <nav className="session-turn-nav" aria-label="Turn navigation">
            <button
              type="button"
              className={`session-turn-nav-scroll${scrollThrough ? " is-enabled" : ""}`}
              aria-label={scrollThrough ? "Disable scroll through" : "Enable scroll through"}
              aria-pressed={scrollThrough}
              title={scrollThrough ? "disable scroll through" : "enable scroll through"}
              onClick={toggleScrollThrough}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
              </svg>
            </button>
            <div className="session-turn-nav-track">
              <button
                type="button"
                className="session-turn-nav-button"
                aria-label="Previous turn"
                title="Previous turn"
                disabled={navigation.previous == null}
                onClick={() => navigation.previous != null && selectTurn(navigation.previous)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4 10 4-4 4 4" />
                </svg>
              </button>
              <span className="session-turn-nav-position" aria-label={`Turn ${navigation.current} of ${navigation.total}`}>
                <span>{navigation.current}</span>
                <span className="session-turn-nav-divider" />
                <span>{navigation.total}</span>
              </span>
              <button
                type="button"
                className="session-turn-nav-button"
                aria-label="Next turn"
                title="Next turn"
                disabled={navigation.next == null}
                onClick={() => {
                  if (navigation.next == null) return;
                  selectTurn(navigation.nextIsLatest ? null : navigation.next);
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>
            </div>
            <button
              type="button"
              className="session-turn-nav-latest"
              aria-label={sessionRunning ? "Go to active turn" : "Go to latest turn"}
              title={sessionRunning ? "Go to active turn" : "Go to latest turn"}
              disabled={navigation.next == null}
              onClick={() => selectTurn(null)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 5 4 4 4-4M4 12h8" />
              </svg>
            </button>
          </nav>
        )}
      </div>

      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}
