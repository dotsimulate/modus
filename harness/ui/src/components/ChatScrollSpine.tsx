/**
 * ChatScrollSpine — replaces the native scrollbar in the chat view with
 * an index of the conversation. Two modes:
 *
 * "spine" — the original. Each message is one 1px-tall hairline whose
 *   length (2–6px) reflects its weight. Assistant ticks extend left of a
 *   center axis, user ticks extend right, commits dimmer.
 *
 * "ruler" — turn-indexed. Three lanes and nothing on the axis itself:
 *   prose hairlines far left (length = prose weight), the turn's tool run
 *   nudged inboard left (length = call count, log-scaled), and the user's
 *   own turns as accent rungs on the right. Turn numbers appear on hover
 *   in the margin left of the spine, so they cost no width; the turn the
 *   viewport is currently inside stays labelled without hovering.
 *
 *   The ruler exists because the spine encodes weight, and a user message
 *   is short — so the landmarks you actually navigate by were rendering as
 *   the faintest marks in the field.
 *
 * Both modes adapt to density: as the gap between turns closes, a per-turn
 * mark that stays bright and wide fills the column solid, so weight is
 * given back and then marks thin to every Nth turn. Below ~2px of gap no
 * mark can distinguish turns and only stepping/scrubbing navigates.
 *
 * Tick positions are computed from STABLE estimates only. They never
 * shift as the user scrolls (DOM-measured heights of the virtualized
 * messages do not feed back into the spine). The viewport hairlines and
 * "visible" brightening track the real scroll position, which can drift
 * a few pixels from estimates as items are measured — but the index
 * itself stays still, which is what makes it usable as a navigator.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, GitCommit } from "../../../sdk/index";
import { resolveSpineClickTarget } from "../scroll-navigation";
import type { VirtualLayoutSnapshot } from "./VirtualMessageList";

export type ChatSpineItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "commit"; key: string; commit: GitCommit };

/**
 * Stable per-item measurement. `total` is what the spine lays out against;
 * `prose` and `tools` split it so the ruler can give each its own lane, and
 * `toolCount` is the call count behind that tool span (which may be one
 * collapsed header on screen, so the count is not derivable from the height).
 */
export type ChatSpineMeasure = {
  total: number;
  prose: number;
  tools: number;
  toolCount: number;
};

export type ChatScrollIndicatorMode = "spine" | "ruler";

type Props = {
  items: ChatSpineItem[];
  /** Which index to draw. "scroll" never mounts this component at all. */
  mode: ChatScrollIndicatorMode;
  /** The chat scroll element — spine reads scrollTop / clientHeight to brighten visible ticks. */
  scrollEl: HTMLElement | null;
  /**
   * Stable per-item measurement. Spine builds its own offsets map from
   * this; consumers must keep the callback's identity stable across
   * unrelated re-renders (memoize it) so the spine layout doesn't churn.
   */
  measureItem: (item: ChatSpineItem) => ChatSpineMeasure;
  /**
   * Live measured layout snapshot from the virtualizer. Used to convert
   * real scroll position (in measured-space) into the spine's stable
   * estimate-space, so hairlines and ticks always agree on a message's
   * position. Read on every render — consumer mutates the ref in place
   * (no setState).
   */
  measuredLayoutRef?: React.MutableRefObject<VirtualLayoutSnapshot | null>;
  /** Click on a tick scrolls to that message. */
  onItemClick?: (key: string, within: number) => void;
};

type Role = "assistant" | "user" | "tools" | "thinking" | "commit" | "system";

type Tick = {
  key: string;
  role: Role;
  /** 1-based index of the turn this item belongs to. */
  turn: number;
  startFraction: number;
  centerFraction: number;
  length: number;
  side: "left" | "right";
  /** Ruler lanes. */
  proseLength: number;
  toolStartFraction: number;
  toolSpan: number;
  toolCount: number;
};

const MIN_TICK_PX = 2;
const MAX_TICK_PX = 6;

/** Ruler prose lane. Sits at -12..-6, clearing the tool lane. */
const RULER_PROSE_MIN_PX = 2;
const RULER_PROSE_MAX_PX = 6;

/**
 * Ruler tool lane, at -5..-1. A run of five or more collapses to a single
 * ~28px header in the transcript, so the mark has almost no vertical extent
 * to work with and the count has to live in length instead. Log-scaled:
 * the step from 5 to 25 calls matters more than the one from 200 to 250.
 */
function toolMarkLength(count: number): number {
  return 1.5 + Math.min(Math.log10(Math.max(count, 1)) / 2.4, 1) * 2.5;
}

/**
 * Turn marks stop being an index once they collide. Measured against the
 * real geometry: a 700px axis holds ~51px between turns at 12 turns, 9.4px
 * at 60, 5.2px at 120, 2.1px at 300. Past the second threshold a mark that
 * keeps full weight fills the column solid.
 */
function densityTier(medianGapPx: number): 1 | 2 | 3 {
  if (medianGapPx >= 8) return 1;
  if (medianGapPx >= 3.5) return 2;
  return 3;
}

/** Stride that keeps surviving marks about `spacingPx` apart. */
function markStride(medianGapPx: number, spacingPx: number): number {
  if (medianGapPx <= 0) return 1;
  return Math.max(1, Math.ceil(spacingPx / medianGapPx));
}

function classify(item: ChatSpineItem): { role: Role; side: "left" | "right" } {
  if (item.kind === "commit") return { role: "commit", side: "left" };
  const m = item.message;
  if (m.role === "user") return { role: "user", side: "right" };
  if (m.role === "system") return { role: "system", side: "left" };
  // assistant variants
  if (!m.content && m.toolCalls?.length) return { role: "tools", side: "left" };
  if (m.thinking) return { role: "thinking", side: "left" };
  return { role: "assistant", side: "left" };
}

export function ChatScrollSpine({
  items,
  mode,
  scrollEl,
  measureItem,
  measuredLayoutRef,
  onItemClick,
}: Props) {
  // ── Stable per-item layout from estimates ──
  // Recomputed only when items or the estimate function change — never
  // when DOM measurements arrive — so tick positions hold still during
  // scroll. The hairlines below convert real scroll position INTO this
  // estimate-space so the two always agree on where a message lives.
  const layout = useMemo(() => {
    if (!items.length) {
      return {
        ticks: [] as Tick[],
        turns: [] as Tick[],
        estStart: new Map<string, number>(),
        estHeight: new Map<string, number>(),
        total: 0,
      };
    }
    const measures = items.map((item) => measureItem(item));
    const heights = measures.map((m) => Math.max(m.total, 1));
    const total = heights.reduce((s, h) => s + h, 0) || 1;
    // 95th-percentile soft cap so a single huge turn doesn't crush every
    // other tick to 2px.
    const percentileCap = (values: number[]) => {
      const sorted = [...values].sort((a, b) => b - a);
      return Math.max(sorted[Math.max(0, Math.floor(sorted.length * 0.05))] ?? 1, 1);
    };
    const cap = percentileCap(heights);
    // The ruler's prose lane scales against prose alone, so a turn that is
    // mostly tool calls doesn't also max out its prose hairline.
    const proseCap = percentileCap(measures.map((m) => Math.max(m.prose, 1)));

    const estStart = new Map<string, number>();
    const estHeight = new Map<string, number>();
    let acc = 0;
    let turn = 0;
    const ticks: Tick[] = items.map((item, i) => {
      const h = heights[i];
      const m = measures[i];
      const start = acc;
      acc += h;
      estStart.set(item.key, start);
      estHeight.set(item.key, h);
      const { role, side } = classify(item);
      if (role === "user") turn += 1;
      return {
        key: item.key,
        role,
        side,
        turn,
        startFraction: start / total,
        centerFraction: (start + h / 2) / total,
        length: MIN_TICK_PX + Math.min(h / cap, 1) * (MAX_TICK_PX - MIN_TICK_PX),
        proseLength:
          RULER_PROSE_MIN_PX +
          Math.min(m.prose / proseCap, 1) * (RULER_PROSE_MAX_PX - RULER_PROSE_MIN_PX),
        // The tool span sits after the prose inside the same bubble.
        toolStartFraction: (start + m.prose) / total,
        toolSpan: m.tools / total,
        toolCount: m.toolCount,
      };
    });
    return { ticks, turns: ticks.filter((t) => t.role === "user"), estStart, estHeight, total };
  }, [items, measureItem]);

  const { ticks, turns, estStart, estHeight, total: estTotal } = layout;

  /**
   * Map a real measured scrollTop (chat-space) into this spine's
   * estimate-space fraction. The conversion finds the spine item whose
   * measured offset bracket contains scrollTop, then maps the same
   * fractional position into that item's estimate-space slot.
   *
   * After a click: scrollTop lands exactly at the clicked message's
   * measured offset → fraction-into-message is 0 → hairline lands at
   * that message's estimate-space start, which is exactly where its
   * tick is drawn. Click → tick → hairline all agree.
   */
  const measuredScrollToSpineFraction = (scrollTop: number): number => {
    if (estTotal <= 0) return 0;
    const measured = measuredLayoutRef?.current;
    if (!measured) {
      // Fallback before the virtualizer has published anything.
      const sh = scrollEl?.scrollHeight ?? 0;
      return sh > 0 ? scrollTop / sh : 0;
    }
    let prevKey: string | null = null;
    let prevMeasOff = 0;
    let prevMeasH = 1;
    for (const item of items) {
      const mOff = measured.offsets.get(item.key);
      if (mOff == null) continue;
      if (mOff > scrollTop) break;
      prevKey = item.key;
      prevMeasOff = mOff;
      prevMeasH = Math.max(measured.heights.get(item.key) ?? 1, 1);
    }
    if (prevKey == null) return 0;
    const fracInto = Math.min(Math.max((scrollTop - prevMeasOff) / prevMeasH, 0), 1);
    const eStart = estStart.get(prevKey) ?? 0;
    const eH = estHeight.get(prevKey) ?? 1;
    return Math.min(Math.max((eStart + fracInto * eH) / estTotal, 0), 1);
  };

  // ── Track scroll viewport for "is-visible" tick brightening + hairlines ──
  // Reads from the real DOM scroll element so hairlines slide smoothly
  // with scroll. Mismatch with estimate-space tick positions is bounded
  // (5px per item by the virtualizer's measure threshold).
  const [viewport, setViewport] = useState({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
  useEffect(() => {
    if (!scrollEl) return;
    const update = () => {
      setViewport({
        scrollTop: scrollEl.scrollTop,
        clientHeight: scrollEl.clientHeight,
        scrollHeight: scrollEl.scrollHeight,
      });
    };
    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(scrollEl);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [scrollEl]);

  // Both edges are converted from measured scroll-space into the spine's
  // estimate-space — same coordinate system as the ticks, so a click
  // that scrolls to message X lands the hairline exactly on X's tick.
  const visibleStart = measuredScrollToSpineFraction(viewport.scrollTop);
  const visibleEnd = measuredScrollToSpineFraction(viewport.scrollTop + viewport.clientHeight);

  const axisRef = useRef<HTMLDivElement>(null);

  // Axis height in real pixels, so density thresholds are measured rather
  // than assumed. Only re-read on resize — it does not change with scroll.
  const [axisHeight, setAxisHeight] = useState(0);
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAxisHeight(el.getBoundingClientRect().height));
    ro.observe(el);
    setAxisHeight(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  }, []);

  const density = useMemo(() => {
    if (turns.length < 2 || axisHeight <= 0) {
      return { tier: 1 as const, rungStride: 1, labelStride: 1 };
    }
    const gaps = turns
      .slice(1)
      .map((t, i) => (t.startFraction - turns[i].startFraction) * axisHeight)
      .sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)] ?? 0;
    const tier = densityTier(median);
    return {
      tier,
      rungStride: tier === 1 ? 1 : markStride(median, 9),
      labelStride: markStride(median, 12),
    };
  }, [turns, axisHeight]);

  /**
   * A click resolves to the item span that owns that position. Long items
   * retain the clicked position; nearby user turns remain magnetic landmarks.
   */
  const resolveTarget = useCallback(
    (fraction: number) => resolveSpineClickTarget(ticks, turns, fraction),
    [ticks, turns],
  );

  const fractionAt = useCallback((clientY: number): number => {
    const rect = axisRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return 0;
    return Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
  }, []);

  const handleAxisClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onItemClick) return;
      const target = resolveTarget(fractionAt(e.clientY));
      if (target) onItemClick(target.key, target.within);
    },
    [resolveTarget, fractionAt, onItemClick],
  );

  // Which turn the pointer is over, so the ruler can name it. Null when the
  // pointer is away — the current turn stays labelled on its own.
  const [hoverTurn, setHoverTurn] = useState<number | null>(null);
  const handleAxisMove = useCallback(
    (e: React.MouseEvent) => {
      if (mode !== "ruler") return;
      const fraction = fractionAt(e.clientY);
      let nearest: number | null = null;
      let best = Infinity;
      for (const t of turns) {
        const d = Math.abs(fraction - t.startFraction);
        if (d < best) {
          best = d;
          nearest = t.turn;
        }
      }
      setHoverTurn(nearest);
    },
    [mode, turns, fractionAt],
  );
  const clearHover = useCallback(() => setHoverTurn(null), []);

  if (!items.length) return null;

  // The turn the viewport top is inside — the ruler keeps this one labelled
  // whether or not the pointer is anywhere near the spine.
  let currentTurn = 0;
  for (const t of turns) {
    if (t.startFraction > visibleStart) break;
    currentTurn = t.turn;
  }

  return (
    <aside
      className={`chat-scroll-spine chat-scroll-spine--${mode}`}
      data-density={density.tier}
      aria-hidden="true"
    >
      <div
        ref={axisRef}
        className="chat-scroll-spine-axis"
        onClick={handleAxisClick}
        onMouseMove={handleAxisMove}
        onMouseLeave={clearHover}
      >
        {mode === "spine" && ticks.map((t) => {
          const isVisible = t.centerFraction >= visibleStart && t.centerFraction <= visibleEnd;
          const style: React.CSSProperties = t.side === "right"
            ? { top: `${t.centerFraction * 100}%`, left: "50%", width: t.length }
            : { top: `${t.centerFraction * 100}%`, right: "50%", width: t.length };
          return (
            <span
              key={t.key}
              className={
                `chat-scroll-tick chat-scroll-tick--${t.role}` +
                (isVisible ? " is-visible" : "")
              }
              style={style}
            />
          );
        })}

        {mode === "ruler" && ticks.map((t) => {
          if (t.role === "user") {
            const isVisible = t.startFraction >= visibleStart && t.startFraction <= visibleEnd;
            const isMajor = density.rungStride === 1 || t.turn % density.rungStride === 0;
            const isCurrent = t.turn === currentTurn;
            const labelled =
              t.turn === hoverTurn ||
              (isCurrent && hoverTurn === null) ||
              (hoverTurn !== null && (density.labelStride === 1 || t.turn % density.labelStride === 0));
            return (
              <Fragment key={t.key}>
                <span
                  className={
                    "chat-scroll-rung" +
                    (isVisible ? " is-visible" : "") +
                    (isMajor ? " is-major" : "") +
                    (isCurrent ? " is-current" : "")
                  }
                  style={{ top: `${t.startFraction * 100}%` }}
                />
                {labelled && (
                  <span
                    className={
                      "chat-scroll-rung-no" +
                      (isCurrent ? " is-current" : "") +
                      (t.turn === hoverTurn ? " is-near" : "")
                    }
                    style={{ top: `${t.startFraction * 100}%` }}
                  >
                    {String(t.turn).padStart(2, "0")}
                  </span>
                )}
              </Fragment>
            );
          }

          const proseVisible = t.centerFraction >= visibleStart && t.centerFraction <= visibleEnd;
          const proseCenter = t.toolStartFraction - (t.toolStartFraction - t.startFraction) / 2;
          return (
            <Fragment key={t.key}>
              <span
                className={
                  `chat-scroll-prose chat-scroll-prose--${t.role}` +
                  (proseVisible ? " is-visible" : "")
                }
                style={{ top: `${proseCenter * 100}%`, width: t.proseLength }}
              />
              {t.toolCount > 0 && (
                <>
                  {/* The run's real extent. Collapsed it is a couple of pixels
                      and reads as nothing; expanded it draws the whole run. */}
                  {t.toolSpan > 0.0006 && (
                    <span
                      className={"chat-scroll-toolrun" + (proseVisible ? " is-visible" : "")}
                      style={{
                        top: `${t.toolStartFraction * 100}%`,
                        height: `${t.toolSpan * 100}%`,
                      }}
                    />
                  )}
                  <span
                    className={"chat-scroll-tool" + (proseVisible ? " is-visible" : "")}
                    style={{
                      top: `${(t.toolStartFraction + t.toolSpan / 2) * 100}%`,
                      width: toolMarkLength(t.toolCount),
                    }}
                  />
                </>
              )}
            </Fragment>
          );
        })}

        {viewport.scrollHeight > 0 && (
          <>
            <span
              className="chat-scroll-viewport-edge chat-scroll-viewport-edge--top"
              style={{ top: `${visibleStart * 100}%` }}
            />
            <span
              className="chat-scroll-viewport-edge chat-scroll-viewport-edge--bottom"
              style={{ top: `${visibleEnd * 100}%` }}
            />
          </>
        )}
      </div>
    </aside>
  );
}
