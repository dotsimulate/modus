/**
 * ChatScrollSpine — replaces the native scrollbar in the chat view with
 * a sparse index of thin horizontal ticks.
 *
 * Each message is one 1px-tall hairline. Length (2–6px) reflects its
 * weight. Assistant ticks extend left of a center axis; user ticks extend
 * right; commits/system extend left and dimmer.
 *
 * Currently-visible ticks brighten AND a pair of top/bottom hairlines
 * traces the viewport edges. Hover brightens the tick; click scrolls
 * to that message.
 *
 * Tick positions are computed from STABLE estimates only. They never
 * shift as the user scrolls (DOM-measured heights of the virtualized
 * messages do not feed back into the spine). The viewport hairlines and
 * "visible" brightening track the real scroll position, which can drift
 * a few pixels from estimates as items are measured — but the index
 * itself stays still, which is what makes it usable as a navigator.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Message, GitCommit } from "../../../sdk/index";
import type { VirtualLayoutSnapshot } from "./VirtualMessageList";

export type ChatSpineItem =
  | { kind: "message"; key: string; message: Message }
  | { kind: "commit"; key: string; commit: GitCommit };

type Props = {
  items: ChatSpineItem[];
  /** The chat scroll element — spine reads scrollTop / clientHeight to brighten visible ticks. */
  scrollEl: HTMLElement | null;
  /**
   * Stable per-item height estimate. Spine builds its own offsets map
   * from this; consumers must keep the callback's identity stable across
   * unrelated re-renders (memoize it) so the spine layout doesn't churn.
   */
  estimateItemHeight: (item: ChatSpineItem) => number;
  /**
   * Live measured layout snapshot from the virtualizer. Used to convert
   * real scroll position (in measured-space) into the spine's stable
   * estimate-space, so hairlines and ticks always agree on a message's
   * position. Read on every render — consumer mutates the ref in place
   * (no setState).
   */
  measuredLayoutRef?: React.MutableRefObject<VirtualLayoutSnapshot | null>;
  /** Click on a tick scrolls to that message. */
  onItemClick?: (key: string) => void;
};

type Role = "assistant" | "user" | "tools" | "thinking" | "commit" | "system";

type Tick = {
  key: string;
  role: Role;
  centerFraction: number;
  length: number;
  side: "left" | "right";
};

const MIN_TICK_PX = 2;
const MAX_TICK_PX = 6;

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
  scrollEl,
  estimateItemHeight,
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
        estStart: new Map<string, number>(),
        estHeight: new Map<string, number>(),
        total: 0,
      };
    }
    const heights = items.map((item) => Math.max(estimateItemHeight(item), 1));
    const total = heights.reduce((s, h) => s + h, 0) || 1;
    // 95th-percentile soft cap so a single huge turn doesn't crush every
    // other tick to 2px.
    const sorted = [...heights].sort((a, b) => b - a);
    const capIdx = Math.max(0, Math.floor(sorted.length * 0.05));
    const cap = Math.max(sorted[capIdx] ?? 1, 1);

    const estStart = new Map<string, number>();
    const estHeight = new Map<string, number>();
    let acc = 0;
    const ticks: Tick[] = items.map((item, i) => {
      const h = heights[i];
      const start = acc;
      acc += h;
      estStart.set(item.key, start);
      estHeight.set(item.key, h);
      const { role, side } = classify(item);
      const norm = Math.min(h / cap, 1);
      return {
        key: item.key,
        role,
        side,
        centerFraction: (start + h / 2) / total,
        length: MIN_TICK_PX + norm * (MAX_TICK_PX - MIN_TICK_PX),
      };
    });
    return { ticks, estStart, estHeight, total };
  }, [items, estimateItemHeight]);

  const { ticks, estStart, estHeight, total: estTotal } = layout;

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

  const handleAxisClick = useCallback(
    (e: React.MouseEvent) => {
      if (!axisRef.current || !ticks.length || !onItemClick) return;
      const rect = axisRef.current.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      let closest = ticks[0];
      let bestDist = Math.abs(fraction - closest.centerFraction);
      for (let i = 1; i < ticks.length; i++) {
        const d = Math.abs(fraction - ticks[i].centerFraction);
        if (d < bestDist) {
          bestDist = d;
          closest = ticks[i];
        }
      }
      onItemClick(closest.key);
    },
    [ticks, onItemClick],
  );

  if (!items.length) return null;

  return (
    <aside className="chat-scroll-spine" aria-hidden="true">
      <div
        ref={axisRef}
        className="chat-scroll-spine-axis"
        onClick={handleAxisClick}
      >
        {ticks.map((t) => {
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
