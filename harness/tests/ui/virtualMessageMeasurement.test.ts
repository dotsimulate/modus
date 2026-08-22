import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordVirtualHeight } from "../../ui/src/virtual-message-measurement";

describe("virtual message measurements", () => {
  it("preserves measured geometry when an unmount reports zero", () => {
    const heights = new Map([["m1", 713]]);
    const measuredKeys = new Set(["m1"]);

    expect(recordVirtualHeight(heights, measuredKeys, "m1", 0)).toEqual({
      changed: false,
      previous: 713,
    });
    expect(heights.get("m1")).toBe(713);
  });

  it("does not cache a zero measurement for a newly mounted row", () => {
    const heights = new Map<string, number>();
    const measuredKeys = new Set<string>();

    expect(recordVirtualHeight(heights, measuredKeys, "m1", 0).changed).toBeFalse();
    expect(heights.has("m1")).toBeFalse();
    expect(measuredKeys.has("m1")).toBeFalse();
  });

  it("records a later positive measurement normally", () => {
    const heights = new Map([["m1", 528]]);
    const measuredKeys = new Set<string>();

    expect(recordVirtualHeight(heights, measuredKeys, "m1", 713)).toEqual({
      changed: true,
      previous: 528,
    });
    expect(heights.get("m1")).toBe(713);
    expect(measuredKeys.has("m1")).toBeTrue();
  });

  it("disconnects row observers before virtualized DOM is removed", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "ui", "src", "components", "VirtualMessageList.tsx"),
      "utf8",
    );
    const measuredItem = source.slice(source.indexOf("function MeasuredItem"));

    expect(measuredItem).toContain("useLayoutEffect(() => {");
    expect(measuredItem).not.toContain("useEffect(() => {");
    expect(source).toContain("const update = recordVirtualHeight(");
  });

  it("keeps mounted rows in document flow between virtual spacers", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "ui", "src", "components", "VirtualMessageList.tsx"),
      "utf8",
    );
    const measuredItem = source.slice(source.indexOf("function MeasuredItem"));

    expect(source).toContain('style={{ height: beforeHeight }}');
    expect(source).toContain('style={{ height: afterHeight }}');
    expect(measuredItem).toContain('style={{ display: "flow-root" }}');
    expect(measuredItem).not.toContain('position: "absolute"');
  });
});
