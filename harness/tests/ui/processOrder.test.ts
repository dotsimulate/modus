import { describe, expect, test } from "bun:test";
import type { ProcessInfo } from "../../sdk/types";
import { sortProcesses } from "../../ui/src/widgets/process-order";

function processInfo(id: string, startedAt: number, lastEventAt: number, kind: ProcessInfo["kind"] = "session"): ProcessInfo {
  return {
    id, startedAt, lastEventAt, kind, status: "idle", profile: null,
    provider: "test", model: null, costUsd: 0, numTurns: 0, preview: "",
    cwd: null, mission: null, activeMoves: [], subscribers: 0, canKill: false,
  };
}

describe("process widget ordering", () => {
  const processes = [
    processInfo("orchestrator", 100, 150, "orchestrator"),
    processInfo("worker", 200, 300, "worker"),
    processInfo("resumed-session", 50, 500),
    processInfo("new-session", 400, 400),
    processInfo("unknown-start", 0, 0),
  ];

  test("recent activity wins across process kinds and original start times", () => {
    expect(sortProcesses(processes, "activity").map(p => p.id)).toEqual([
      "resumed-session", "new-session", "worker", "orchestrator", "unknown-start",
    ]);
  });

  test("newest started ignores recent activity and kind", () => {
    expect(sortProcesses(processes, "started").map(p => p.id)).toEqual([
      "new-session", "worker", "orchestrator", "resumed-session", "unknown-start",
    ]);
  });

  test("a process with no events yet uses its start time", () => {
    const starting = processInfo("starting", 600, 0);
    expect(sortProcesses([...processes, starting], "activity")[0]).toBe(starting);
  });

  test("ties use start time then id so polling does not shuffle equal rows", () => {
    const tied = [processInfo("b", 20, 100), processInfo("older", 10, 100), processInfo("a", 20, 100)];
    for (const order of ["activity", "started"] as const) {
      expect(sortProcesses(tied, order).map(p => p.id)).toEqual(["a", "b", "older"]);
      expect(sortProcesses([...tied].reverse(), order).map(p => p.id)).toEqual(["a", "b", "older"]);
    }
  });

  test("sorting preserves the polled snapshot", () => {
    const snapshot = Object.freeze([...processes]);
    expect(sortProcesses(snapshot, "activity")).not.toBe(snapshot);
    expect(snapshot.map(p => p.id)).toEqual(processes.map(p => p.id));
  });
});
