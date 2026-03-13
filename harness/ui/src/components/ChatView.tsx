import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { MessageBubble } from "./MessageBubble";
import { GitActivityItem } from "./GitActivityItem";
import { UserMeta } from "./UserMeta";
import { FileChanges, extractFileEdits } from "./FileChanges";
import { QueuedMessage } from "./QueuedMessage";
import { fetchGitLog, fetchGitShow } from "../api";
import type { Message, ToolCall, GitCommit } from "../api";
import type { QueuedMessage as QueuedMessageType } from "../providers/SessionProvider";
import { navigateToGitRoute } from "../git-route";

type DisplayItem =
  | { kind: "message"; key: string; message: Message; index: number }
  | { kind: "commit"; key: string; commit: GitCommit };

type CommitCandidate = {
  commit: GitCommit;
  matchedFiles: string[];
};

const COMMIT_MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

function commitSubject(message: string): string {
  return message.split("\n")[0]?.trim() || "(no message)";
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
  showGitEvents?: boolean;
  cwd?: string | null;
  emptyTitle?: string;
  emptySubtitle?: string;
  queuedMessage?: QueuedMessageType | null;
  onCancelQueued?: () => void;
  onSessionTagsChange?: () => void;
  onBranch?: (seq: number, prefill?: string) => void;
  onStopTask?: (taskId: string) => void;
};

export function ChatView({ messages, sessionId, sessionTags, provider, profileName, model, streaming, streamFeed, showThinking = true, showMeta = true, showToolCalls = true, showGitEvents = true, cwd, emptyTitle, emptySubtitle, queuedMessage, onCancelQueued, onSessionTagsChange, onBranch, onStopTask }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);
  const autoScrollRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [commitFilesByHash, setCommitFilesByHash] = useState<Map<string, string[]>>(new Map());
  const hasMessages = messages.length > 0;
  const lastMessage = hasMessages ? messages[messages.length - 1] : null;

  const isNearBottom = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= 120;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const el = scrollRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    // Don't hide button eagerly — let syncScrollState hide it
    // once the scroll actually lands. Prevents the button vanishing
    // while the scroll silently fails on mobile.
    el.scrollTop = el.scrollHeight;
    // For smooth, also try scrollTo — but scrollTop is the reliable fallback
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }
  }, []);

  const syncScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pinnedToBottom = isNearBottom(el);
    autoScrollRef.current = pinnedToBottom;
    setShowScrollBtn(hasMessages && !pinnedToBottom);
  }, [hasMessages, isNearBottom]);

  // Scroll to bottom on initial load and when user sends a message.
  // Ongoing stickiness is handled below by explicit bottom-pin tracking.
  useEffect(() => {
    if (!hasMessages) return;
    const last = messages[messages.length - 1];
    if (!hasScrolledRef.current || last?.role === "user") {
      hasScrolledRef.current = true;
      scrollToBottom("auto");
    }
  }, [hasMessages, messages, scrollToBottom]);

  // Track whether the user is still pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    syncScrollState();
    el.addEventListener("scroll", syncScrollState, { passive: true });
    return () => el.removeEventListener("scroll", syncScrollState);
  }, [syncScrollState]);

  // Keep the viewport pinned while content grows, but only if the user
  // has not intentionally scrolled away from the bottom.
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || !("ResizeObserver" in window)) return;
    const observer = new ResizeObserver(() => {
      if (!autoScrollRef.current) return;
      requestAnimationFrame(() => {
        if (autoScrollRef.current) scrollToBottom("auto");
      });
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  // Mobile keyboards and address bars resize the visual viewport —
  // re-pin to bottom when this happens so we don't lose position.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (autoScrollRef.current) {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  // Streaming updates can change content without changing element size
  // immediately, so also pin on render while we are in sticky mode.
  useEffect(() => {
    if (!autoScrollRef.current || !hasMessages) return;
    const rafId = requestAnimationFrame(() => {
      if (autoScrollRef.current) scrollToBottom("auto");
    });
    return () => cancelAnimationFrame(rafId);
  }, [hasMessages, messages, streamFeed, streaming, queuedMessage, scrollToBottom]);

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

  useEffect(() => {
    if (!showGitEvents || !cwd) {
      setCommits([]);
      setCommitFilesByHash(new Map());
      return;
    }

    let active = true;
    const load = async () => {
      try {
        const next = await fetchGitLog(cwd, 200);
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
    if (!showGitEvents || !cwd || commits.length === 0) {
      setCommitFilesByHash(new Map());
      return;
    }

    let active = true;
    const recentCommits = [...commits]
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 40);
    const missing = recentCommits.filter((commit) => !commitFilesByHash.has(commit.hash));
    if (missing.length === 0) return;

    const load = async () => {
      const entries = await Promise.all(
        missing.map(async (commit) => {
          try {
            const detail = await fetchGitShow(cwd, commit.hash);
            return [commit.hash, detail.files.map((file) => file.path)] as const;
          } catch {
            return [commit.hash, [] as string[]] as const;
          }
        }),
      );

      if (!active) return;
      setCommitFilesByHash((prev) => {
        const next = new Map(prev);
        for (const [hash, files] of entries) next.set(hash, files);
        return next;
      });
    };

    void load();
    return () => {
      active = false;
    };
  }, [commitFilesByHash, commits, cwd, showGitEvents]);

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
  const claimedCommitTags = useMemo(
    () => new Set((sessionTags ?? []).filter((tag) => tag.startsWith("commit:"))),
    [sessionTags],
  );

  const commitCandidatesByMessage = useMemo(() => {
    const candidates = new Map<number, CommitCandidate>();
    if (!showGitEvents || !cwd || commits.length === 0) return candidates;

    const sortedCommits = [...commits].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

    for (const [messageIndex, toolCalls] of turnFileEdits.entries()) {
      const msg = messages[messageIndex];
      if (!msg || msg.role !== "assistant" || msg.timestamp == null) continue;

      const editedFiles = new Set(extractFileEdits(toolCalls).map((edit) => edit.filePath));
      if (editedFiles.size === 0) continue;

      const startTs = msg.timestamp;
      const endTs = Math.min(
        startTs + COMMIT_MATCH_WINDOW_MS,
        messages
          .slice(messageIndex + 1)
          .find((next) => next.role === "user" && next.timestamp != null)?.timestamp ?? Number.POSITIVE_INFINITY,
      );

      for (const commit of sortedCommits) {
        const commitTs = Date.parse(commit.date);
        if (Number.isNaN(commitTs) || commitTs <= startTs) continue;
        if (commitTs > endTs) break;

        const commitFiles = commitFilesByHash.get(commit.hash);
        if (!commitFiles || commitFiles.length === 0) continue;

        const matchedFiles = commitFiles.filter((file) => editedFiles.has(file));
        if (matchedFiles.length === 0) continue;

        candidates.set(messageIndex, { commit, matchedFiles });
        break;
      }
    }

    return candidates;
  }, [commitFilesByHash, commits, cwd, messages, showGitEvents, turnFileEdits]);

  const showAssistantPrelude = streaming && lastMessage?.role === "user";
  const assistantPreludeLabel = [profileName, model].filter(Boolean).join(" ");

  if (messages.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">{emptyTitle ?? "ready"}</div>
        <div className="empty-state-sub">{emptySubtitle ?? "start typing to begin"}</div>
      </div>
    );
  }

  return (
    <div className="chat-scroll-wrapper">
      <div className="chat-messages" ref={scrollRef}>
        <div className="chat-messages-content" ref={contentRef}>
          {displayItems.map((item) => {
            if (item.kind === "commit") {
              return (
                <div key={item.key} className="message message--git" data-role="git">
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
            const showFileChanges = turnTools && extractFileEdits(turnTools).length > 0;
            const commitCandidate = commitCandidatesByMessage.get(i);

            return msg.role === "system" ? (
              <div key={msg.id} className="system-divider">
                <span>{msg.content}</span>
              </div>
            ) : (
              <div key={msg.id}>
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
                  showToolCalls={showToolCalls}
                  showGitEvents={showGitEvents}
                  cwd={cwd}
                  lastTodoId={lastTodoId}
                  streamFeed={streaming && i === messages.length - 1 && msg.role === "assistant"
                    ? streamFeed
                    : undefined}
                  onBranch={msg.role === "user" && msg.seq != null ? onBranch : undefined}
                  onStopTask={onStopTask}
                >
                  {showFileChanges && <FileChanges toolCalls={turnTools} />}
                  {commitCandidate && (
                    <button
                      className="message-commit-detected"
                      onClick={() => navigateToGitRoute({ commit: commitCandidate.commit.hash })}
                      type="button"
                    >
                      <span className="message-commit-detected-dot" aria-hidden="true" />
                      <span className="message-commit-detected-label">commit detected</span>
                      <span className="message-commit-detected-copy">
                        could be this session&apos;s work
                      </span>
                      <span className="message-commit-detected-hash">{shortHash(commitCandidate.commit.hash)}</span>
                      <span className="message-commit-detected-copy">
                        {commitSubject(commitCandidate.commit.message)}
                      </span>
                      <span className="message-commit-detected-meta">
                        {commitCandidate.matchedFiles.length} file{commitCandidate.matchedFiles.length === 1 ? "" : "s"} matched
                        {" \u00b7 "}
                        {formatCommitWhen(commitCandidate.commit.date)}
                      </span>
                    </button>
                  )}
                </MessageBubble>
                {msg.role === "user" && (
                  <UserMeta msg={msg} onBranch={onBranch} />
                )}
              </div>
            );
          })}
          {showAssistantPrelude && (
            <div className="message message--assistant-prelude" data-role="assistant">
              <div className="message-meta message-meta--assistant-prelude">
                <span className="sc-noise">
                  <span className="sc-resolved">
                    {assistantPreludeLabel || provider || "assistant"}
                  </span>
                  <span className="sc-glyphs"> responding ....</span>
                </span>
              </div>
            </div>
          )}
          <div ref={endRef} className="chat-anchor" />
        </div>
      </div>
      {queuedMessage && onCancelQueued && (
        <QueuedMessage message={queuedMessage} onCancel={onCancelQueued} />
      )}
      <div
        className={`scroll-to-bottom${showScrollBtn ? " visible" : ""}`}
        onClick={() => scrollToBottom()}
      >
        <div className="scroll-to-bottom-inner">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}
