const {
  getActionRuns,
  insertActionRun,
  updateActionRun,
} = await import("../../db");

const runId = insertActionRun(
  "__completion_answerer_test__",
  "project:test",
  1,
  null,
  Date.now(),
  1,
  "manual",
  null,
  undefined,
  "completion",
);
updateActionRun(runId, {
  status: "done",
  completedAt: Date.now(),
  summary: "Named session",
  answerer: "completion",
  answererMetadata: {
    oneShotId: "os-db-1",
    provider: "litellm",
    model: "ornith",
    transport: "in-process",
    elapsedMs: 321,
    usage: { input: 12, output: 4, totalTokens: 16, costUsd: 0 },
    stopReason: "stop",
  },
});

await Bun.write(
  Bun.stdout,
  `${JSON.stringify(getActionRuns("__completion_answerer_test__", 1, "project:test")[0])}\n`,
);
// db.ts intentionally owns a 30-second WAL checkpoint timer in the harness.
// This isolated verification driver has completed its synchronous writes.
process.exit(0);
