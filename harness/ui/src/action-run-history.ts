import type { ActionRun } from "../../sdk/index";

export type ActionRunHistoryItem =
  | { kind: "run"; run: ActionRun }
  | {
      kind: "skipped";
      count: number;
      newest: ActionRun;
      oldest: ActionRun;
    };

/** Collapse gather-null runs into one summary at the newest skip's position. */
export function collapseSkippedActionRuns(runs: ActionRun[]): ActionRunHistoryItem[] {
  const items: ActionRunHistoryItem[] = [];
  let skipped: Extract<ActionRunHistoryItem, { kind: "skipped" }> | null = null;

  for (const run of runs) {
    if (run.status !== "skipped") {
      items.push({ kind: "run", run });
      continue;
    }

    if (!skipped) {
      skipped = { kind: "skipped", count: 1, newest: run, oldest: run };
      items.push(skipped);
      continue;
    }

    skipped.count += 1;
    skipped.oldest = run;
  }

  return items;
}
