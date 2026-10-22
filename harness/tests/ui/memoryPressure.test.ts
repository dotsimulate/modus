import { describe, expect, test } from "bun:test";
import type { MemoryStatus } from "../../sdk/index";
import { describeMemoryPressure } from "../../ui/src/memory-pressure";

const base: MemoryStatus = {
  totalGB: 189.6, freeGB: 4.4, usedGB: 185.2, usagePercent: 97.7,
  pressureThreshold: 90, pressureBlockingEnabled: true, maxHeapPerProcessMB: 4096,
  maxConcurrentSessions: 10, watchdogRunning: true,
};

describe("memory pressure notice", () => {
  test("says nothing below the threshold or on a backend without the field", () => {
    expect(describeMemoryPressure(null)).toBeNull();
    expect(describeMemoryPressure(base)).toBeNull();
    expect(describeMemoryPressure({ ...base, highPressure: false })).toBeNull();
  });

  test("names the largest processes while sessions are refused", () => {
    expect(describeMemoryPressure({
      ...base, highPressure: true, spawnBlocked: true,
      largestProcesses: [{ name: "Surfshark", memoryGB: 180.4, count: 1 }, { name: "chrome", memoryGB: 3, count: 12 }],
    })).toEqual({
      level: "blocked",
      title: "Memory nearly full: new sessions are paused",
      detail: "185.2 of 189.6 GB in use (98%). Largest: Surfshark 180.4 GB, chrome 3.0 GB (12 processes).",
    });
  });

  test("warns without claiming a block while headroom remains", () => {
    const notice = describeMemoryPressure({ ...base, usedGB: 172, usagePercent: 90.7, highPressure: true, spawnBlocked: false });
    expect(notice?.level).toBe("high");
    expect(notice?.detail).toBe("172.0 of 189.6 GB in use (91%).");
  });
});
