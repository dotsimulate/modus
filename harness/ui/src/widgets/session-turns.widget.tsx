/**
 * Session Turns widget — the turn index for a conversation.
 *
 * Config: { "type": "session-turns", "id": "ticker", "orientation": "vertical" }
 *
 * Publishes the page context key `turnSeq`, which `session-turn` reads. That
 * one key is the whole coupling: a page can put this rail anywhere, or leave it
 * out entirely and let the card track live.
 *
 * Two sources are merged. The server's turn index covers the *whole* session
 * without bodies, because history only ever arrives a page at a time and a rail
 * that showed only what happened to be loaded would grow new entries as the
 * user paged backwards rather than showing the shape of the conversation up
 * front. Loaded messages then overwrite the entries they cover, because a live
 * turn is newer than any index fetch and the event source cannot report tool
 * counts at all.
 *
 * Follow behavior is "advance only at the live edge": watching the newest turn
 * carries you to the next one, and having flipped back leaves you where you
 * are with the rail marking that a newer turn exists. That is the transcript's
 * sticky-bottom rule, which is what makes it feel familiar rather than novel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ensureSubscribed,
  useSessionHistoryLoadState,
  useSessionState,
} from "../sessionStore";
import { modus } from "../modusClient";
import { buildTurns, turnProseWeight, turnToolCalls } from "../turn-segments";
import type { SessionTurnIndexEntry } from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type SessionTurnsConfig = WidgetBase & {
  type: "session-turns";
  sessionId?: string;
  /** "vertical" is a rail down the side; "horizontal" is a strip. */
  orientation?: "vertical" | "horizontal";
  /** Show the prompt's first line beside each mark. Off for a bare rail. */
  labels?: boolean;
};

/** One rail entry, whatever it was assembled from. */
type TurnMark = {
  number: number;
  seq: number;
  timestamp: number;
  promptWeight: number;
  /** Absent on the event source, which cannot count tools without parsing payloads. */
  toolCount?: number;
  textWeight?: number;
  /** First line of the prompt. Only for turns whose content is loaded. */
  label?: string;
  loaded: boolean;
};

/**
 * Tool-mark length, log-scaled. Lifted from the chat ruler, where the scale was
 * chosen against real geometry: the step from 5 to 25 calls matters more than
 * the one from 200 to 250, and a collapsed run has almost no vertical extent to
 * carry the count in instead.
 */
function toolMarkLength(count: number): number {
  return 1.5 + Math.min(Math.log10(Math.max(count, 1)) / 2.4, 1) * 2.5;
}

/** Prose-mark length against the field's own 95th percentile, so one enormous
 *  turn cannot crush every other mark to the minimum. */
function proseMarkLength(weight: number, cap: number): number {
  return 2 + Math.min(weight / Math.max(cap, 1), 1) * 4;
}

function percentileCap(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => b - a);
  return Math.max(sorted[Math.floor(sorted.length * 0.05)] ?? 1, 1);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line.trim().slice(0, 80);
}

export default function SessionTurnsWidget({ config, pageContext }: WidgetProps<SessionTurnsConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;
  const orientation = config.orientation === "horizontal" ? "horizontal" : "vertical";

  const rawTurnSeq = pageContext?.get("turnSeq");
  const selectedSeq = typeof rawTurnSeq === "number" ? rawTurnSeq : null;

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const messages = useMemo(() => session?.messages ?? [], [session?.messages]);

  // ── Server index ──
  const [index, setIndex] = useState<SessionTurnIndexEntry[]>([]);
  const [indexError, setIndexError] = useState(false);
  // Refetched when the conversation grows, so a rail opened mid-session keeps up
  // without polling. Message count is the cheapest signal that a turn landed.
  const messageCount = messages.length;
  useEffect(() => {
    if (!sessionId) {
      setIndex([]);
      return;
    }
    let active = true;
    const controller = new AbortController();
    modus.getSessionTurnIndex(sessionId, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        setIndex(result.turns);
        setIndexError(false);
      })
      .catch(() => {
        // The rail still works from loaded messages alone; it just cannot show
        // turns nobody has fetched yet.
        if (active) setIndexError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, messageCount]);

  // ── Merge ──
  const marks = useMemo<TurnMark[]>(() => {
    const loadedTurns = buildTurns(messages, historyLoad.olderTurnCount);
    const byNumber = new Map<number, TurnMark>();

    for (const entry of index) {
      byNumber.set(entry.number, {
        number: entry.number,
        seq: entry.seq,
        timestamp: entry.timestamp,
        promptWeight: entry.promptWeight,
        ...(entry.toolCount != null ? { toolCount: entry.toolCount } : {}),
        ...(entry.textWeight != null ? { textWeight: entry.textWeight } : {}),
        loaded: false,
      });
    }

    for (const turn of loadedTurns) {
      if (turn.seq == null) continue;
      const prompt = turn.prompt?.content ?? "";
      byNumber.set(turn.number, {
        number: turn.number,
        seq: turn.seq,
        timestamp: turn.prompt?.timestamp ?? turn.body[0]?.timestamp ?? 0,
        promptWeight: prompt.length,
        toolCount: turnToolCalls(turn).length,
        textWeight: turnProseWeight(turn),
        ...(prompt ? { label: firstLine(prompt) } : {}),
        loaded: true,
      });
    }

    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  }, [index, messages, historyLoad.olderTurnCount]);

  const liveMark = marks[marks.length - 1] ?? null;
  const proseCap = useMemo(
    () => percentileCap(marks.map((mark) => mark.textWeight ?? mark.promptWeight)),
    [marks],
  );

  const select = useCallback((seq: number) => {
    pageContext?.set("turnSeq", seq);
  }, [pageContext]);

  // ── Follow at the live edge ──
  // Tracked as "was the selection the newest turn last time we looked", because
  // by the time a new turn exists the selection is no longer the newest one and
  // the question can no longer be asked of the current state.
  const wasAtLiveEdge = useRef(true);
  const lastLiveSeq = useRef<number | null>(null);
  useEffect(() => {
    if (!liveMark) return;
    const isNewTurn = lastLiveSeq.current !== null && lastLiveSeq.current !== liveMark.seq;
    if (!isNewTurn) {
      lastLiveSeq.current = liveMark.seq;
      return;
    }
    if (wasAtLiveEdge.current) select(liveMark.seq);
    lastLiveSeq.current = liveMark.seq;
  }, [liveMark, select]);

  useEffect(() => {
    // An unset selection means the card is already tracking live on its own.
    wasAtLiveEdge.current = selectedSeq == null || selectedSeq === liveMark?.seq;
  }, [selectedSeq, liveMark?.seq]);

  const behindLiveEdge = selectedSeq != null && liveMark != null && selectedSeq !== liveMark.seq;
  const sessionRunning = session?.status === "running" || session?.status === "starting";

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session) return <WidgetEmptyState>loading session…</WidgetEmptyState>;
  if (marks.length === 0) {
    return <WidgetEmptyState>{historyLoad.status === "loading" ? "loading turns…" : "no turns yet"}</WidgetEmptyState>;
  }

  return (
    <div className={`session-turns session-turns--${orientation}`}>
      <div className="session-turns-head">
        <span className="session-turns-count">{marks.length} turns</span>
        {indexError && <span className="session-turns-partial" title="Showing loaded turns only">partial</span>}
        {behindLiveEdge && (
          <button
            type="button"
            className={`session-turns-jump${sessionRunning ? " is-running" : ""}`}
            onClick={() => liveMark && select(liveMark.seq)}
          >
            {sessionRunning ? "live" : "latest"}
          </button>
        )}
      </div>

      <div className="session-turns-rail">
        {marks.map((mark) => {
          const isSelected = selectedSeq != null
            ? mark.seq === selectedSeq
            : mark.number === liveMark?.number;
          const isLive = mark.number === liveMark?.number && !!sessionRunning;
          return (
            <button
              type="button"
              key={mark.number}
              className={
                "session-turns-mark"
                + (isSelected ? " is-selected" : "")
                + (isLive ? " is-live" : "")
                + (mark.loaded ? "" : " is-unloaded")
              }
              onClick={() => select(mark.seq)}
              title={mark.label ?? `turn ${mark.number}`}
            >
              <span className="session-turns-no">{String(mark.number).padStart(2, "0")}</span>
              <span className="session-turns-bars">
                <span
                  className="session-turns-prose"
                  style={{ [orientation === "vertical" ? "width" : "height"]: proseMarkLength(mark.textWeight ?? mark.promptWeight, proseCap) }}
                />
                {mark.toolCount != null && mark.toolCount > 0 && (
                  <span
                    className="session-turns-tool"
                    style={{ [orientation === "vertical" ? "width" : "height"]: toolMarkLength(mark.toolCount) }}
                  />
                )}
              </span>
              {config.labels !== false && mark.label && (
                <span className="session-turns-label">{mark.label}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
