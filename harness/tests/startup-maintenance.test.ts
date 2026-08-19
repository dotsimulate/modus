import { describe, expect, test } from "bun:test";
import { runStartupMaintenanceTasks } from "../startup-maintenance";

describe("startup maintenance", () => {
  test("a prune failure is reported without preventing readiness", () => {
    const warnings: string[] = [];
    let reachedReadiness = false;

    expect(() => {
      runStartupMaintenanceTasks(
        [
          { label: "cleanup", run: () => {} },
          {
            label: "event pruning",
            run: () => {
              throw new Error("SQLITE_READONLY");
            },
          },
        ],
        (message) => warnings.push(message),
      );
      reachedReadiness = true;
    }).not.toThrow();

    expect(reachedReadiness).toBe(true);
    expect(warnings).toEqual([expect.stringContaining("Startup event pruning skipped")]);
    expect(warnings[0]).toContain("SQLITE_READONLY");
  });

  test("one failed task does not suppress later maintenance", () => {
    const ran: string[] = [];
    runStartupMaintenanceTasks(
      [
        {
          label: "cleanup",
          run: () => {
            throw new Error("locked");
          },
        },
        {
          label: "event pruning",
          run: () => {
            ran.push("prune");
          },
        },
      ],
      () => {},
    );
    expect(ran).toEqual(["prune"]);
  });
});
