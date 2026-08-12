import {
  useRef,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  type ReactNode,
} from "react";
import { estimateMessageHeight, clearMeasureCache } from "./textMeasure";
import { calculateScrollTarget } from "../scroll-navigation";

export type VirtualItem<T> = {
  data: T;
  key: string;
};

export type HeightEstimator<T> = (item: T, containerWidth: number) => number;

/**
 * Imperative API exposed via `controlsRef`. Lets external companions
 * (e.g. ChatScrollSpine) request scroll without going through prop /
 * state plumbing — and crucially without fighting the stickyBottom
 * effect, which the controls reset before scrolling.
 */
export type VirtualListControls = {
  scrollToKey(key: string, opts?: { offset?: number; behavior?: ScrollBehavior; within?: number }): void;
};

/**
 * Live measured layout snapshot. Mutated in place by the virtualizer on
 * every measurement update. Companions read it on demand (via a ref —
 * no re-renders) to convert between scroll position and item identity.
 */
export type VirtualLayoutSnapshot = {
  offsets: Map<string, number>;
  heights: Map<string, number>;
  total: number;
};

type Props<T> = {
  items: VirtualItem<T>[];
  estimateHeight: HeightEstimator<T>;
  renderItem: (item: T, index: number) => ReactNode;
  overscan?: number;
  stickyBottom?: boolean;
  className?: string;
  innerClassName?: string;
  onScrollStateChange?: (atBottom: boolean) => void;
  scrollToBottomTrigger?: unknown;
  footer?: ReactNode;
  /**
   * Fired once the underlying scroll element is mounted (and again with null
   * on unmount). Lets external companions like ChatScrollSpine read scroll
   * position and clientHeight without owning the scroll container themselves.
   */
  onScrollElement?: (el: HTMLDivElement | null) => void;
  /**
   * Imperative controls. Attach a ref; the virtualizer populates it with
   * methods like `scrollToKey`. Cleared on unmount.
   */
  controlsRef?: React.MutableRefObject<VirtualListControls | null>;
  /**
   * Live layout snapshot. The virtualizer rewrites this ref whenever
   * heights change (estimates fill in, then DOM measurements arrive).
   * Read-only from the consumer's perspective; reading it does NOT
   * trigger re-renders, so use it from event handlers / render paths
   * that already re-render for some other reason (scroll, resize).
   */
  layoutRef?: React.MutableRefObject<VirtualLayoutSnapshot | null>;
};

const BOTTOM_THRESHOLD = 120;
const WIDTH_CHANGE_THRESHOLD = 10;

export function VirtualMessageList<T>({
  items,
  estimateHeight,
  renderItem,
  overscan = 3,
  stickyBottom = true,
  className,
  innerClassName,
  onScrollStateChange,
  scrollToBottomTrigger,
  footer,
  onScrollElement,
  controlsRef,
  layoutRef,
}: Props<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  const widthRef = useRef(0);
  const heightMapRef = useRef(new Map<string, number>());
  const measuredSetRef = useRef(new Set<string>());
  const [heightVersion, setHeightVersion] = useState(0);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const getItemHeight = (item: VirtualItem<T>): number => {
    const cached = heightMapRef.current.get(item.key);
    if (cached != null) return cached;
    const width = widthRef.current || 700;
    const estimated = estimateHeight(item.data, width);
    heightMapRef.current.set(item.key, estimated);
    return estimated;
  };

  const computeTotalHeight = (): number => {
    let h = 0;
    for (const item of items) h += getItemHeight(item);
    return h;
  };

  void heightVersion;
  const totalHeight = computeTotalHeight();

  const computeVisibleRange = () => {
    let offset = 0;
    let startIndex = 0;
    let endIndex = items.length - 1;
    let foundStart = false;

    for (let i = 0; i < items.length; i++) {
      const h = getItemHeight(items[i]);
      if (!foundStart && offset + h > scrollTop) {
        startIndex = Math.max(0, i - overscan);
        foundStart = true;
      }
      if (foundStart && offset > scrollTop + viewportHeight) {
        endIndex = Math.min(items.length - 1, i + overscan);
        break;
      }
      offset += h;
    }

    if (!foundStart) startIndex = Math.max(0, items.length - 1);
    return { startIndex, endIndex };
  };

  const { startIndex, endIndex } = computeVisibleRange();

  const getOffsetForIndex = (index: number): number => {
    let offset = 0;
    for (let i = 0; i < index && i < items.length; i++) {
      offset += getItemHeight(items[i]);
    }
    return offset;
  };

  const invalidateAllHeights = useCallback(() => {
    heightMapRef.current.clear();
    measuredSetRef.current.clear();
    setHeightVersion(n => n + 1);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD;
    if (atBottom !== atBottomRef.current) {
      atBottomRef.current = atBottom;
      onScrollStateChange?.(atBottom);
    }
  }, [onScrollStateChange]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const newWidth = el.clientWidth;
      const widthChanged = Math.abs(newWidth - widthRef.current) > WIDTH_CHANGE_THRESHOLD;
      widthRef.current = newWidth;
      setViewportHeight(el.clientHeight);

      if (widthChanged) {
        invalidateAllHeights();
      }

      if (atBottomRef.current) scrollToBottom();
    });
    ro.observe(el);
    widthRef.current = el.clientWidth;
    setViewportHeight(el.clientHeight);
    onScrollElement?.(el);
    return () => {
      ro.disconnect();
      onScrollElement?.(null);
    };
  }, [scrollToBottom, invalidateAllHeights, onScrollElement]);

  useLayoutEffect(() => {
    if (stickyBottom && atBottomRef.current) {
      scrollToBottom();
      const el = scrollRef.current;
      if (el) setScrollTop(el.scrollTop);
    }
  }, [items, stickyBottom, scrollToBottom, heightVersion]);

  useEffect(() => {
    if (scrollToBottomTrigger !== undefined) scrollToBottom();
  }, [scrollToBottomTrigger, scrollToBottom]);

  // Keep a live ref to items so the imperative controls (which capture
  // their closure once) always walk the current list.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Pending settle-correction timers from the most recent scrollToKey.
  // After the browser's native smooth scroll completes, items above the
  // target may have been measured (heights changed), and the target
  // offset has therefore shifted. We re-read the live target and snap
  // the few-pixel drift away. Multiple passes catch late measurements.
  const settleTimersRef = useRef<number[]>([]);
  const settleAbortedRef = useRef(false);

  // Populate the external controls ref with imperative methods. The
  // closure here is stable (it reads everything via refs), so we attach
  // it once on mount and clear it on unmount — no churn during scroll.
  useEffect(() => {
    if (!controlsRef) return;
    const clearSettles = () => {
      for (const id of settleTimersRef.current) clearTimeout(id);
      settleTimersRef.current = [];
    };
    controlsRef.current = {
      scrollToKey(key, opts) {
        const el = scrollRef.current;
        if (!el) return;

        // Walk items + heightMap to find live target offset for `key`.
        const computeTarget = (): number | null => {
          let offset = 0;
          for (const item of itemsRef.current) {
            const height = getItemHeight(item);
            if (item.key === key) {
              const padding = opts?.offset ?? 12;
              const max = Math.max(0, el.scrollHeight - el.clientHeight);
              return calculateScrollTarget(offset, height, opts?.within ?? 0, padding, max);
            }
            offset += height;
          }
          return null;
        };

        const initialTarget = computeTarget();
        if (initialTarget == null) return;

        // Critical: clear the sticky-bottom flag BEFORE scrolling so the
        // stickyBottom layout effect doesn't fight us back to the bottom
        // when measurements arrive mid-animation.
        atBottomRef.current = false;

        // Cancel any pending settle from a previous click.
        clearSettles();
        settleAbortedRef.current = false;

        // Native smooth scroll — the browser owns timing and event
        // throttling, so we don't drown React in 60fps re-renders. The
        // tradeoff is that the target locks in here and won't follow
        // measurement updates; we correct that with the settle below.
        el.scrollTo({
          top: initialTarget,
          behavior: opts?.behavior ?? "smooth",
        });

        // If the user starts scrolling themselves, abort settles — they
        // took over and we shouldn't yank them around.
        const onUserInput = () => {
          settleAbortedRef.current = true;
          clearSettles();
          el.removeEventListener("wheel", onUserInput);
          el.removeEventListener("touchstart", onUserInput);
          el.removeEventListener("keydown", onUserInput);
        };
        el.addEventListener("wheel", onUserInput, { passive: true });
        el.addEventListener("touchstart", onUserInput, { passive: true });
        el.addEventListener("keydown", onUserInput);

        // Schedule a series of settle passes after the smooth scroll
        // would have completed. Each pass: re-read live target, and if
        // it's drifted from where we landed, snap to it (instant, just a
        // few pixels typically — too small to read as a jump, but
        // enough to land precisely on the message the user clicked).
        const settle = () => {
          if (settleAbortedRef.current) return;
          const liveTarget = computeTarget();
          if (liveTarget == null) return;
          const drift = liveTarget - el.scrollTop;
          if (Math.abs(drift) > 1) {
            el.scrollTop = liveTarget;
          }
        };
        // Schedule settles at 380ms (after ~native smooth completes),
        // and again at 600/900ms to catch measurements that arrive late.
        settleTimersRef.current.push(window.setTimeout(settle, 380));
        settleTimersRef.current.push(window.setTimeout(settle, 600));
        settleTimersRef.current.push(window.setTimeout(() => {
          settle();
          el.removeEventListener("wheel", onUserInput);
          el.removeEventListener("touchstart", onUserInput);
          el.removeEventListener("keydown", onUserInput);
        }, 900));
      },
    };
    return () => {
      clearSettles();
      if (controlsRef.current) controlsRef.current = null;
    };
    // controlsRef identity is owned by the parent and assumed stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlsRef]);

  // Publish a measured layout snapshot to the consumer's ref. Mutates
  // a ref (no setState) so measurement updates don't cascade re-renders
  // through the consumer or its companions. Consumers that need to
  // observe changes here should re-render for some other reason
  // (e.g. ChatScrollSpine re-renders on scroll).
  useEffect(() => {
    if (!layoutRef) return;
    const offsets = new Map<string, number>();
    const heights = new Map<string, number>();
    let acc = 0;
    for (const item of items) {
      const h = getItemHeight(item);
      offsets.set(item.key, acc);
      heights.set(item.key, h);
      acc += h;
    }
    layoutRef.current = { offsets, heights, total: acc };
    // getItemHeight reads heightMapRef alongside heightVersion bumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, heightVersion, layoutRef]);

  const reportMeasured = useCallback((key: string, height: number) => {
    const existing = heightMapRef.current.get(key);
    if (measuredSetRef.current.has(key) && existing === height) return;
    if (existing != null && Math.abs(height - existing) < 5) return;
    heightMapRef.current.set(key, height);
    measuredSetRef.current.add(key);
    setHeightVersion(n => n + 1);
  }, []);

  return (
    <div
      ref={scrollRef}
      className={className}
      style={{ overflow: "auto", position: "relative", height: "100%" }}
      onScroll={handleScroll}
    >
      <div
        ref={contentRef}
        className={innerClassName}
        style={{ height: totalHeight, position: "relative" }}
      >
        {items.slice(startIndex, endIndex + 1).map((item, i) => {
          const index = startIndex + i;
          const top = getOffsetForIndex(index);
          return (
            <MeasuredItem
              key={item.key}
              itemKey={item.key}
              top={top}
              onMeasured={reportMeasured}
            >
              {renderItem(item.data, index)}
            </MeasuredItem>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

function MeasuredItem({
  itemKey,
  top,
  onMeasured,
  children,
}: {
  itemKey: string;
  top: number;
  onMeasured: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      onMeasured(itemKey, el.offsetHeight);
    });
    ro.observe(el);
    onMeasured(itemKey, el.offsetHeight);
    return () => ro.disconnect();
  }, [itemKey, onMeasured]);

  return (
    <div ref={ref} style={{ position: "absolute", top, left: 0, right: 0 }}>
      {children}
    </div>
  );
}

export { estimateMessageHeight, clearMeasureCache };
