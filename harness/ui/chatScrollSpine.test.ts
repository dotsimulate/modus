import { describe, expect, test } from "bun:test";
import { calculateScrollTarget, resolveSpineClickTarget } from "./src/scroll-navigation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("chat scroll spine navigation", () => {
  const ticks = [
    { key: "small-first", startFraction: 0 },
    { key: "tall-assistant", startFraction: 0.02 },
    { key: "user-turn", startFraction: 0.82 },
  ];
  const turns = [ticks[2]!];

  test("selects the span actually clicked instead of the nearest center", () => {
    const target = resolveSpineClickTarget(ticks, turns, 0.2);
    expect(target?.key).toBe("tall-assistant");
    expect(target?.within).toBeCloseTo(0.225);
  });

  test("preserves a position inside a tall message", () => {
    const target = resolveSpineClickTarget(ticks, turns, 0.62);
    expect(target?.key).toBe("tall-assistant");
    expect(target?.within).toBeCloseTo(0.75);
  });

  test("still magnetizes clicks close to a user turn", () => {
    expect(resolveSpineClickTarget(ticks, turns, 0.811)).toEqual({
      key: "user-turn",
      within: 0,
    });
  });

  test("returns no target for an empty conversation", () => {
    expect(resolveSpineClickTarget([], [], 0.5)).toBeNull();
  });

  test("maps the within-message position to a bounded scroll offset", () => {
    expect(calculateScrollTarget(100, 1000, 0.5, 12, 2000)).toBeCloseTo(587.5);
    expect(calculateScrollTarget(10, 100, -1, 12, 2000)).toBe(0);
    expect(calculateScrollTarget(1900, 1000, 2, 12, 2000)).toBe(2000);
  });

  test("keeps ruler numbers close to the axis", () => {
    const css = readFileSync(join(import.meta.dir, "src/styles/components/chat-scroll-spine.css"), "utf8");
    expect(css).toContain("right: calc(50% + 4px)");
    expect(css).not.toContain("right: calc(50% + 15px)");
  });
});
