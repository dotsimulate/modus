export type ScrollBottomMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * How close to the end of the scroll range still counts as "at the bottom".
 * Generous on purpose: the jump-to-bottom affordance is noise when the reader
 * is already within a screenful of the live edge.
 */
export const BOTTOM_THRESHOLD = 120;

export function isAtBottom(
  metrics: ScrollBottomMetrics,
  threshold: number = BOTTOM_THRESHOLD,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export type ScrollBottomTracker = {
  /** Whether the list should keep pinning itself to the bottom as content grows. */
  readonly following: boolean;
  /** Geometry is authoritative: it settles both the follow intent and the report. */
  measure(metrics: ScrollBottomMetrics): void;
  /** A programmatic scroll to the end. Reports immediately; geometry confirms. */
  follow(): void;
  /** A programmatic scroll to somewhere else. Reports nothing — geometry will. */
  detach(): void;
};

/**
 * Two facts about a chat scroll container, deliberately kept apart:
 *
 *  - `following` — sticky-bottom intent, which programmatic scrolls move.
 *  - the last at-bottom value handed to the consumer.
 *
 * Conflating them was a live bug. Every mutation of the follow flag was
 * treated as "the consumer already knows this", so a programmatic scroll
 * (restoring a saved anchor on session revisit, a spine click, a focused
 * turn) silently consumed the consumer's next real transition: the reader
 * scrolled up, the measured value matched the flag the programmatic scroll
 * had already written, nothing was reported, and the jump-to-bottom control
 * stayed hidden until the reader reached the bottom once to resynchronize.
 */
export function createScrollBottomTracker(
  notify: (atBottom: boolean) => void,
  initiallyAtBottom = true,
): ScrollBottomTracker {
  let following = initiallyAtBottom;
  let reported = initiallyAtBottom;

  const report = (atBottom: boolean) => {
    if (atBottom === reported) return;
    reported = atBottom;
    notify(atBottom);
  };

  return {
    get following() {
      return following;
    },
    measure(metrics) {
      const atBottom = isAtBottom(metrics);
      following = atBottom;
      report(atBottom);
    },
    follow() {
      following = true;
      report(true);
    },
    detach() {
      following = false;
    },
  };
}
