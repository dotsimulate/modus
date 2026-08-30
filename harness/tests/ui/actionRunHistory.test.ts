import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ActionRun } from "../../sdk/types";
import { collapseSkippedActionRuns } from "../../ui/src/action-run-history";

const actionsSource = readFileSync(resolve(import.meta.dir, "../../ui/src/components/Actions.tsx"), "utf8");
const actionsStyles = readFileSync(resolve(import.meta.dir, "../../ui/src/styles/views/actions.css"), "utf8");

function run(runNumber: number, status: string): ActionRun {
  return {
    id: runNumber,
    actionName: "fixture",
    sessionId: status === "skipped" ? null : `session-${runNumber}`,
    runNumber,
    cycleNumber: 1,
    status,
    summary: null,
    startedAt: runNumber * 1_000,
    completedAt: runNumber * 1_000 + 500,
    costUsd: 0,
    error: null,
    triggerType: "interval",
    afterRunError: null,
    answerer: "session",
  };
}

describe("action run history", () => {
  test("leaves histories without intended skips unchanged", () => {
    const runs = [run(3, "done"), run(2, "error")];

    expect(collapseSkippedActionRuns(runs)).toEqual([
      { kind: "run", run: runs[0] },
      { kind: "run", run: runs[1] },
    ]);
  });

  test("collapses all gather-null skips into one tally", () => {
    const runs = [
      run(8, "skipped"),
      run(7, "skipped"),
      run(6, "done"),
      run(5, "skipped"),
      run(4, "error"),
    ];

    const items = collapseSkippedActionRuns(runs);

    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      kind: "skipped",
      count: 3,
      newest: runs[0],
      oldest: runs[3],
    });
    expect(items.slice(1)).toEqual([
      { kind: "run", run: runs[2] },
      { kind: "run", run: runs[4] },
    ]);
  });

  test("puts the tally where the newest skipped run appeared", () => {
    const runs = [run(5, "done"), run(4, "skipped"), run(3, "done")];

    expect(collapseSkippedActionRuns(runs).map((item) => item.kind)).toEqual([
      "run",
      "skipped",
      "run",
    ]);
  });

  test("renders the gather-null tally with a quiet skipped tone", () => {
    expect(actionsSource).toContain(
      'className="sched-run-status-label sched-run-status-label--skipped">gather returned null',
    );
    expect(actionsStyles).toMatch(
      /\.sched-run-status-label--skipped\s*\{[^}]*color:\s*var\(--text-muted\)/s,
    );
  });

  test("renders completion telemetry instead of inventing a session link", () => {
    expect(actionsSource).toContain('run.answerer === "completion"');
    expect(actionsSource).toContain("completion.usage.totalTokens");
    expect(actionsSource).toContain("completion.stopReason");
  });
});
