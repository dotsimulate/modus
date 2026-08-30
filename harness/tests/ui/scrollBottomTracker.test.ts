import { describe, expect, it } from "bun:test";
import {
  BOTTOM_THRESHOLD,
  createScrollBottomTracker,
  isAtBottom,
} from "../../ui/src/scroll-bottom-tracker";

const metrics = (distanceFromBottom: number) => ({
  scrollHeight: 4000,
  clientHeight: 800,
  scrollTop: 4000 - 800 - distanceFromBottom,
});

describe("isAtBottom", () => {
  it("treats the threshold distance as still at the bottom", () => {
    expect(isAtBottom(metrics(BOTTOM_THRESHOLD))).toBe(true);
    expect(isAtBottom(metrics(BOTTOM_THRESHOLD + 1))).toBe(false);
  });

  it("is at the bottom when the content does not overflow", () => {
    expect(isAtBottom({ scrollHeight: 400, clientHeight: 800, scrollTop: 0 })).toBe(true);
  });
});

describe("scroll bottom tracker", () => {
  const setup = () => {
    const reports: boolean[] = [];
    return { reports, tracker: createScrollBottomTracker((v) => reports.push(v)) };
  };

  it("reports only transitions", () => {
    const { reports, tracker } = setup();
    tracker.measure(metrics(0));
    tracker.measure(metrics(10));
    expect(reports).toEqual([]);

    tracker.measure(metrics(900));
    tracker.measure(metrics(1200));
    expect(reports).toEqual([false]);

    tracker.measure(metrics(0));
    expect(reports).toEqual([false, true]);
  });

  it("still reports the next measured position after a programmatic detach", () => {
    const { reports, tracker } = setup();

    // Restoring a saved anchor / jumping to a turn moves the follow intent
    // without the consumer having seen anything.
    tracker.detach();
    expect(tracker.following).toBe(false);
    expect(reports).toEqual([]);

    // The scroll that detach was preparing for now lands away from the end.
    // The consumer has to hear about it — this is the transition that used
    // to be swallowed, leaving the jump-to-bottom control hidden until the
    // reader scrolled all the way down once.
    tracker.measure(metrics(900));
    expect(reports).toEqual([false]);
  });

  it("reports a programmatic scroll to the end immediately and resumes following", () => {
    const { reports, tracker } = setup();
    tracker.measure(metrics(900));
    expect(reports).toEqual([false]);

    tracker.follow();
    expect(tracker.following).toBe(true);
    expect(reports).toEqual([false, true]);

    // The scroll event that follow() triggered confirms the same value.
    tracker.measure(metrics(0));
    expect(reports).toEqual([false, true]);
  });

  it("does not re-report when a detach lands back at the bottom", () => {
    const { reports, tracker } = setup();
    tracker.detach();
    tracker.measure(metrics(4));
    expect(reports).toEqual([]);
    expect(tracker.following).toBe(true);
  });
});
