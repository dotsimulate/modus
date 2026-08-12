import { useEffect, useMemo, useState, useCallback, useRef, memo } from "react";
import { MessageBubble } from "./MessageBubble";
import { GitActivityItem } from "./GitActivityItem";
import { UserMeta } from "./UserMeta";
import { FileChanges, extractFileEdits } from "./FileChanges";
import { QueuedMessage } from "./QueuedMessage";
import { VirtualMessageList, type VirtualItem, type VirtualListControls, type VirtualLayoutSnapshot } from "./VirtualMessageList";
import { estimateMessageHeight, TOOL_CALL_COLLAPSED_HEIGHT } from "./textMeasure";
import { ChatScrollSpine, type ChatSpineItem, type ChatSpineMeasure } from "./ChatScrollSpine";
import { modus } from "../modusClient";
import type { Message, ToolCall, ToolCallDisplayMode, ChatScrollIndicator, CommitAttribution, GitCommit } from "../../../sdk/index";
import type { QueuedMessage as QueuedMessageType } from "../providers/SessionContext";
import { navigateToGitRoute } from "../git-route";
import { INTERFACE_SETTINGS_EVENT, readLocalInterfaceSettings } from "../interface-settings";
import { buildLatestMoveToolCallIds } from "../move-tool-view";

type DisplayItem =
  | { kind: "message"; key: string; message: Message; index: number }
  | { kind: "commit"; key: string; commit: GitCommit };

function readScrollIndicator(): ChatScrollIndicator {
  return readLocalInterfaceSettings().chat.scrollIndicator;
}

function formatCommitWhen(date: string): string {
  const parsed = Date.parse(date);
  if (Number.isNaN(parsed)) return date;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function commitMatchLabel(matchedFiles: string[] | undefined): string {
  if (!matchedFiles?.length) return "file matched this commit";
  if (matchedFiles.length === 1) {
    const parts = matchedFiles[0].split("/").filter(Boolean);
    return `${parts[parts.length - 1] || matchedFiles[0]} matched this commit`;
  }
  return `${matchedFiles.length} files matched this commit`;
}

function countToolCalls(tcs?: ToolCall[]): number {
  if (!tcs) return 0;
  return tcs.length;
}

/**
 * The tool-row share of a message's estimated height. Kept identical to
 * what estimateMessageHeight adds for the same count so the spine and the
 * virtualizer lay out against the same numbers.
 *
 * Known wrong, and deliberately left alone here: MessageBubble collapses a
 * run of TOOL_RUN_GROUP_MIN or more into one ~28px header, so a 100-call
 * run is ~114x shorter on screen than this says. Correcting it changes the
 * virtualizer's spacers for every session, which is a separate change.
 */
function estimateToolRowsHeight(count: number): number {
  return count * TOOL_CALL_COLLAPSED_HEIGHT;
}

function countImages(msg: Message): number {
  return (msg.attachments?.length ?? 0) + (msg.artifacts?.filter(a => a.mime.startsWith("image/")).length ?? 0);
}

type Props = {
  messages: Message[];
  sessionId?: string | null;
  sessionTags?: string[];
  provider?: string;
  profileName?: string | null;
  model?: string | null;
  streaming: boolean;
  streamFeed?: string;
  showThinking?: boolean;
  showMeta?: boolean;
  showToolCalls?: boolean;
  toolCallDisplay?: ToolCallDisplayMode;
  showGitEvents?: boolean;
  showFileChanges?: boolean;
  cwd?: string | null;
  emptyTitle?: string;
  emptySubtitle?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  queuedMessage?: QueuedMessageType | null;
  onCancelQueued?: () => void;
  onSessionTagsChange?: () => void;
  onBranch?: (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => void;
  onStopTask?: (taskId: string) => void;
  onOpenSessionEdits?: () => void;
  hasOlderMessages?: boolean;
  loadingOlderMessages?: boolean;
  olderMessagesError?: string;
  onLoadOlderMessages?: () => void | Promise<void>;
  onLoadMessageDetails?: (seq: number) => void | Promise<void>;
};

export const ChatView = memo(function ChatView({ messages, sessionId, sessionTags, provider, profileName, model, streaming, streamFeed, showThinking = true, showMeta = true, showToolCalls = true, toolCallDisplay = "collapsed", showGitEvents = true, showFileChanges = true, cwd, emptyTitle, emptySubtitle, emptyActionLabel, onEmptyAction, queuedMessage, onCancelQueued, onSessionTagsChange, onBranch, onStopTask, onOpenSessionEdits, hasOlderMessages = false, loadingOlderMessages = false, olderMessagesError, onLoadOlderMessages, onLoadMessageDetails }: Props) {
  const resolvedToolCallDisplay: ToolCallDisplayMode = showToolCalls ? toolCallDisplay : "hidden";
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // Imperative handle into the virtualizer for tick-driven scrolling.
  // Going through this (instead of computing scroll targets externally)
  // lets the virtualizer reset its sticky-bottom flag before scrolling,
  // so a click can't get yanked back to the bottom mid-animation by an
  // arriving measurement update.
  const listControlsRef = useRef<VirtualListControls | null>(null);
  // Live measured layout — virtualizer rewrites this on every height
  // change. Spine reads from it on each render to convert real
  // scrollTop into its stable estimate-space, so hairlines and ticks
  // share one coordinate system.
  const measuredLayoutRef = useRef<VirtualLayoutSnapshot | null>(null);
  // Tracked separately from the layout ref because the spine's estimate
  // function needs it as a (stable, infrequently-changing) dependency.
  const [scrollWidth, setScrollWidth] = useState(0);
  useEffect(() => {
    if (!scrollEl) return;
    const update = () => setScrollWidth(scrollEl.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollEl]);
  const [scrollIndicator, setScrollIndicator] = useState<ChatScrollIndicator>(() => readScrollIndicator());
  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent).detail?.chat?.scrollIndicator;
      if (next === "scroll" || next === "spine" || next === "ruler") setScrollIndicator(next);
    };
    window.addEventListener(INTERFACE_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(INTERFACE_SETTINGS_EVENT, handler);
  }, []);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitAttribution, setCommitAttribution] = useState<CommitAttribution | null>(null);
  const [commitAttributionExpanded, setCommitAttributionExpanded] = useState(false);
  const hasMessages = messages.length > 0;
  const lastMessage = hasMessages ? messages[messages.length - 1] : null;

  const handleScrollState = useCallback((atBottom: boolean) => {
    setShowScrollBtn(hasMessages && !atBottom);
  }, [hasMessages]);

  const [scrollTrigger, setScrollTrigger] = useState(0);
  const handleScrollToBottom = useCallback(() => {
    setScrollTrigger(n => n + 1);
  }, []);

  const lastUserMsgId = useMemo(() => {
    const last = messages[messages.length - 1];
    return last?.role === "user" ? last.id : null;
  }, [messages]);

  useEffect(() => {
    if (lastUserMsgId) setScrollTrigger(n => n + 1);
  }, [lastUserMsgId]);

  const lastUser = useMemo(() => messages.findLastIndex((m: Message) => m.role === "user"), [messages]);
  const lastAssistant = useMemo(() => messages.findLastIndex((m: Message) => m.role === "assistant"), [messages]);

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

  const latestMoveToolCallIds = useMemo(
    () => buildLatestMoveToolCallIds(messages),
    [messages],
  );

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

  useEffect(() => {
    if (!showGitEvents || !cwd) {
      setCommits([]);
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const next = await modus.gitLog(cwd, 200);
        if (active) setCommits(next);
      } catch {
        if (active) setCommits([]);
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [cwd, showGitEvents]);

  useEffect(() => {
    if (!showGitEvents || !sessionId) {
      setCommitAttribution(null);
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const status = await modus.getSessionStatus(sessionId);
        if (active) setCommitAttribution(status.commitAttribution ?? null);
      } catch {
        if (active) setCommitAttribution(null);
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, 4000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [lastMessage?.timestamp, sessionId, showGitEvents]);

  const claimedCommitTags = useMemo(
    () => new Set((sessionTags ?? []).filter((tag) => tag.startsWith("commit:"))),
    [sessionTags],
  );

  const displayItems = useMemo<DisplayItem[]>(() => {
    if (!showGitEvents || !cwd || commits.length === 0 || messages.length === 0) {
      return messages.map((message, index) => ({
        kind: "message" as const,
        key: message.id,
        message,
        index,
      }));
    }

    const sortedCommits = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    const items: DisplayItem[] = [];
    let commitIndex = 0;

    for (let i = 0; i < messages.length; i++) {
      const current = messages[i];
      items.push({ kind: "message", key: current.id, message: current, index: i });

      const currentTs = current.timestamp;
      const nextTs = messages[i + 1]?.timestamp;
      if (currentTs == null || nextTs == null) continue;

      while (commitIndex < sortedCommits.length) {
        const commit = sortedCommits[commitIndex];
        const commitTs = Date.parse(commit.date);
        if (Number.isNaN(commitTs) || commitTs <= currentTs) {
          commitIndex++;
          continue;
        }
        if (commitTs > nextTs) break;
        items.push({ kind: "commit", key: `commit-${commit.hash}`, commit });
        commitIndex++;
      }
    }

    return items;
  }, [commits, cwd, messages, showGitEvents]);

  const virtualItems = useMemo<VirtualItem<DisplayItem>[]>(
    () => displayItems.map(item => ({ key: item.key, data: item })),
    [displayItems],
  );

  const handleLoadOlderMessages = useCallback(async () => {
    if (!onLoadOlderMessages) return;
    const anchorKey = virtualItems[0]?.key;
    await onLoadOlderMessages();
    if (anchorKey) {
      requestAnimationFrame(() => {
        listControlsRef.current?.scrollToKey(anchorKey, { behavior: "auto", offset: 44 });
      });
    }
  }, [onLoadOlderMessages, virtualItems]);

  const spineItems = useMemo<ChatSpineItem[]>(
    () =>
      displayItems
        .filter((item) => {
          if (item.kind === "commit") return true;
          // Skip system messages from the spine — they're tiny dividers and
          // would just add noise to the density picture.
          return item.message.role !== "system";
        })
        .map<ChatSpineItem>((item) =>
          item.kind === "commit"
            ? { kind: "commit", key: item.key, commit: item.commit }
            : { kind: "message", key: item.key, message: item.message },
        ),
    [displayItems],
  );

  // Stable per-item measurement for the spine. Identity changes only when
  // the chat width or the toggle settings change — never on scroll or
  // measurement updates, so the spine's tick layout holds still.
  //
  // Prose and tools are measured separately because the ruler gives each
  // its own lane, and because a tool run's call count is not recoverable
  // from its height once the transcript collapses the run.
  const measureSpineItem = useCallback(
    (item: ChatSpineItem): ChatSpineMeasure => {
      const width = scrollWidth || 700;
      if (item.kind === "commit") {
        return { total: 48, prose: 48, tools: 0, toolCount: 0 };
      }
      const msg = item.message;
      const toolCount = resolvedToolCallDisplay !== "hidden" ? countToolCalls(msg.toolCalls) : 0;
      const prose = estimateMessageHeight(msg.content, width, {
        hasRole: false,
        hasMeta: showMeta && !!msg.meta,
        toolCallCount: 0,
        imageCount: countImages(msg),
        hasThinking: showThinking && !!msg.thinking,
      }).totalHeight;
      const tools = estimateToolRowsHeight(toolCount);
      return { total: prose + tools, prose, tools, toolCount };
    },
    [scrollWidth, showMeta, resolvedToolCallDisplay, showThinking],
  );

  const scrollToSpineItem = useCallback((key: string, within: number) => {
    listControlsRef.current?.scrollToKey(key, { within });
  }, []);

  const estimateHeight = useCallback(
    (item: DisplayItem, containerWidth: number): number => {
      if (item.kind === "commit") return 48;
      const msg = item.message;
      if (msg.role === "system") return 40;
      const estimate = estimateMessageHeight(msg.content, containerWidth, {
        hasRole: false,
        hasMeta: showMeta && !!msg.meta,
        toolCallCount: resolvedToolCallDisplay !== "hidden" ? countToolCalls(msg.toolCalls) : 0,
        imageCount: countImages(msg),
        hasThinking: showThinking && !!msg.thinking,
      });
      return estimate.totalHeight;
    },
    [showMeta, resolvedToolCallDisplay, showThinking],
  );

  const renderItem = useCallback(
    (item: DisplayItem, _virtualIndex: number) => {
      if (item.kind === "commit") {
        return (
          <div className="message message--git" data-role="git">
            <GitActivityItem
              commit={item.commit}
              sessionId={sessionId}
              claimedBySession={claimedCommitTags.has(`commit:${item.commit.hash.slice(0, 7)}`)}
              onClaimChange={onSessionTagsChange}
            />
          </div>
        );
      }

      const msg = item.message;
      const i = item.index;
      const turnTools = turnFileEdits.get(i);
      const hasFileChanges = showFileChanges && turnTools && extractFileEdits(turnTools).length > 0;

      if (msg.role === "system") {
        return (
          <div className="system-divider">
            <span>{msg.content}</span>
          </div>
        );
      }

      return (
        <div className={msg.role === "assistant" && msg.toolCalls?.length && !msg.content ? "message-wrap--tools-only" : undefined}>
          <MessageBubble
            msg={msg}
            provider={provider}
            isNew={streaming && (
              (i === lastUser && msg.role === "user") ||
              (i === lastAssistant && msg.role === "assistant" && !msg.meta)
            )}
            isStreaming={
              streaming && i === messages.length - 1 && msg.role === "assistant"
            }
            hideRole
            showThinking={showThinking}
            showMeta={showMeta}
            toolCallDisplay={resolvedToolCallDisplay}
            showGitEvents={showGitEvents}
            cwd={cwd}
            lastTodoId={lastTodoId}
            streamFeed={streaming && i === messages.length - 1 && msg.role === "assistant"
              ? streamFeed
              : undefined}
            onBranch={msg.role === "user" && msg.seq != null ? onBranch : undefined}
            onStopTask={onStopTask}
            onLoadDetails={msg.detailsDeferred && msg.seq != null && onLoadMessageDetails
              ? () => onLoadMessageDetails(msg.seq!)
              : undefined}
            sessionId={sessionId}
            latestMoveToolCallIds={latestMoveToolCallIds}
          >
            {hasFileChanges && (
              <>
                <FileChanges toolCalls={turnTools} />
                {onOpenSessionEdits && (
                  <div className="turn-session-edits-row">
                    <button
                      className="turn-session-edits-btn"
                      onClick={onOpenSessionEdits}
                      title="View all files edited this session"
                    >
                      <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                        <rect x="1" y="1" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
                        <rect x="1" y="5.5" width="10" height="3" rx="0.5" stroke="currentColor" strokeWidth="1.1"/>
                      </svg>
                      session edits
                    </button>
                  </div>
                )}
              </>
            )}
          </MessageBubble>
          {msg.role === "user" && (
            <UserMeta msg={msg} sessionId={sessionId} provider={provider} onBranch={onBranch} />
          )}
        </div>
      );
    },
    [sessionId, claimedCommitTags, onSessionTagsChange, turnFileEdits, provider,
     streaming, lastUser, lastAssistant, messages.length, showThinking, showMeta,
     resolvedToolCallDisplay, showGitEvents, showFileChanges, cwd, lastTodoId, streamFeed, onBranch, onStopTask,
     onOpenSessionEdits, onLoadMessageDetails, latestMoveToolCallIds],
  );

  const showAssistantPrelude = streaming && lastMessage?.role === "user";
  const assistantPreludeLabel = [profileName, model].filter(Boolean).join(" ");

  const footer = useMemo(() => {
    const elements: React.ReactElement[] = [];

    if (showAssistantPrelude) {
      elements.push(
        <div key="prelude" className="message message--assistant-prelude" data-role="assistant">
          <div className="message-meta message-meta--assistant-prelude">
            <span className="sc-noise">
              <span className="sc-resolved">
                {assistantPreludeLabel || provider || "assistant"}
              </span>
              <span className="sc-glyphs"> responding ....</span>
            </span>
          </div>
        </div>,
      );
    }

    if (showGitEvents && commitAttribution?.matched && commitAttribution.commit) {
      const attrHash = commitAttribution.commit.hash.slice(0, 7);
      const attrClaimed = claimedCommitTags.has(`commit:${attrHash}`);
      elements.push(
        <div key="attr-note" className="message message--git-note" data-role="git-note">
          <button
            className="message-commit-detected"
            onClick={attrClaimed
              ? () => setCommitAttributionExpanded(x => !x)
              : () => navigateToGitRoute({ commit: commitAttribution.commit!.hash })}
            type="button"
          >
            <span className="message-commit-detected-copy">
              {commitMatchLabel(commitAttribution.matchedFiles)}
            </span>
            <span className="message-commit-detected-meta">
              {formatCommitWhen(commitAttribution.commit.date)}
            </span>
          </button>
        </div>,
      );
      if (!attrClaimed || commitAttributionExpanded) {
        elements.push(
          <div key="attr-detail" className="message message--git" data-role="git">
            <GitActivityItem
              commit={commitAttribution.commit}
              sessionId={sessionId}
              claimedBySession={attrClaimed}
              onClaimChange={onSessionTagsChange}
            />
          </div>,
        );
      }
    }

    elements.push(<div key="anchor" className="chat-anchor" />);

    return elements.length > 1 ? <>{elements}</> : <div className="chat-anchor" />;
  }, [showAssistantPrelude, assistantPreludeLabel, provider, showGitEvents,
      commitAttribution, claimedCommitTags, commitAttributionExpanded, sessionId,
      onSessionTagsChange]);

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">{emptyTitle ?? "ready"}</div>
        <div className="empty-state-sub">{emptySubtitle ?? "start typing to begin"}</div>
        {emptyActionLabel && onEmptyAction && (
          <button type="button" className="empty-state-action" onClick={onEmptyAction}>
            {emptyActionLabel}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="chat-scroll-wrapper">
      {(hasOlderMessages || loadingOlderMessages || olderMessagesError) && onLoadOlderMessages && (
        <div className="chat-history-loader">
          <button
            type="button"
            onClick={() => { void handleLoadOlderMessages(); }}
            disabled={loadingOlderMessages}
            title={olderMessagesError}
          >
            {loadingOlderMessages ? "loading earlier messages…" : olderMessagesError ? "retry earlier messages" : "load earlier messages"}
          </button>
        </div>
      )}
      <div className="chat-scroll-row" data-indicator={scrollIndicator}>
        <VirtualMessageList
          items={virtualItems}
          estimateHeight={estimateHeight}
          renderItem={renderItem}
          className="chat-messages"
          innerClassName="chat-messages-content"
          stickyBottom
          onScrollStateChange={handleScrollState}
          scrollToBottomTrigger={scrollTrigger}
          footer={footer}
          onScrollElement={setScrollEl}
          controlsRef={listControlsRef}
          layoutRef={measuredLayoutRef}
        />
        {scrollIndicator !== "scroll" && (
          <ChatScrollSpine
            items={spineItems}
            mode={scrollIndicator}
            scrollEl={scrollEl}
            measureItem={measureSpineItem}
            measuredLayoutRef={measuredLayoutRef}
            onItemClick={scrollToSpineItem}
          />
        )}
      </div>
      {queuedMessage && onCancelQueued && (
        <QueuedMessage message={queuedMessage} onCancel={onCancelQueued} />
      )}
      <div
        className={`scroll-to-bottom${showScrollBtn ? " visible" : ""}`}
        onClick={handleScrollToBottom}
      >
        <div className="scroll-to-bottom-inner">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  );
});
