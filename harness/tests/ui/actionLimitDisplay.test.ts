import { describe, expect, test } from "bun:test";
import {
  describeActionCycleLimit,
  describeActionRunLimit,
} from "../../ui/src/action-limit-display";

describe("action limit display", () => {
  test("describes a large configured run limit as a real cap", () => {
    expect(describeActionRunLimit(712, 99_999, false)).toEqual({
      label: "712 of 99,999 lifetime runs",
      progressPct: 712 / 99_999 * 100,
    });
  });

  test("calls only an absent or non-positive run limit unlimited", () => {
    expect(describeActionRunLimit(712, undefined, false)).toEqual({
      label: "712 lifetime runs · unlimited",
      progressPct: null,
    });
    expect(describeActionRunLimit(7, 0, true)).toEqual({
      label: "7 runs this cycle · unlimited",
      progressPct: null,
    });
  });

  test("makes finite and unlimited cycle semantics explicit", () => {
    expect(describeActionCycleLimit(3, 8)).toEqual({
      label: "cycle 3 of 8",
      progressPct: 25,
    });
    expect(describeActionCycleLimit(12, undefined)).toEqual({
      label: "cycle 12 · unlimited cycles",
      progressPct: null,
    });
  });
});
