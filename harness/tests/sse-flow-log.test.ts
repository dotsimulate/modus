import { describe, expect, test } from "bun:test";
import { sseTimestamp } from "../session-manager";

describe("sse flow log timestamps", () => {
  // The flow log exists to be lined up against the backend log and against
  // renderer timings. A stamp carrying only milliseconds shipped unnoticed once
  // because nothing asserted the shape.
  test("carries hour, minute, second, and milliseconds", () => {
    expect(sseTimestamp()).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});
