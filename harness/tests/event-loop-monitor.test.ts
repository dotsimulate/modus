import { expect, test } from "bun:test";
import { activitiesDuring, startEventLoopMonitor, trackActivity } from "../event-loop-monitor";

test("a stall report names the tool call that held the loop, even after it finished", async () => {
  const lines: string[] = [];
  const stop = startEventLoopMonitor((line) => lines.push(line));
  try {
    const done = trackActivity("session-research:digest [agent]");
    const until = performance.now() + 900;
    while (performance.now() < until) { /* hold the loop like a synchronous op */ }
    done();
    await Bun.sleep(400);
  } finally {
    stop();
  }
  expect(lines.length).toBeGreaterThan(0);
  expect(lines[0]).toMatch(/^\[event-loop\] blocked ~\d+ms while running: .*session-research:digest \[agent\]/);
});

test("only activities overlapping the stall are named", () => {
  let clock = 1_000_000;
  const now = () => clock;
  const early = trackActivity("finished-before", now);
  clock += 100;
  early();
  clock += 5_000;
  const during = trackActivity("during", now);
  clock += 50;
  during();
  const open = trackActivity("still-running", now);
  expect(activitiesDuring(clock - 60, clock)).toEqual(["during", "still-running"]);
  open();
});
