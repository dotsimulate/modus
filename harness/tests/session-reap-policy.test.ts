import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REAP_LIMITS,
  decideIdleReap,
  formatIdleSurvey,
  planIdleReaps,
  shouldAnnounceReclaim,
  type IdleSessionSample,
  type ReapLimits,
} from "../session-reap-policy";

const MB = 1024 * 1024;
const GB = 1024 * MB;
const MINUTE = 60_000;

const LIMITS: ReapLimits = {
  cliRssLimitBytes: 4 * GB,
  pressureRssFloorBytes: 512 * MB,
  pressureGraceMs: 2 * MINUTE,
  idleBackstopMs: 8 * 60 * MINUTE,
};

function sample(overrides: Partial<IdleSessionSample> = {}): IdleSessionSample {
  return {
    sessionId: "s1",
    idleMs: 30 * MINUTE,
    cliRssBytes: 300 * MB,
    treeRssBytes: 300 * MB,
    ...overrides,
  };
}

const CALM = { underPressure: false };
const PRESSURE = { underPressure: true };

describe("decideIdleReap", () => {
  test("leaves an ordinary idle session alone long past the old ten-minute cutoff", () => {
    // The defect this policy replaces: a session was reclaimed purely for being
    // quiet for ten minutes, which killed the provider CLI and every background
    // task under it.
    for (const idleMs of [10 * MINUTE, 30 * MINUTE, 2 * 60 * MINUTE]) {
      expect(decideIdleReap(sample({ idleMs }), CALM, LIMITS).reap).toBe(false);
    }
  });

  test("does not treat a heavy background subprocess as a runaway provider", () => {
    // A session whose agent left a 6 GB build running is doing exactly what the
    // user asked for. Only the provider CLI's own footprint indicates a leak,
    // so the tree total must not reach the CLI rule.
    const decision = decideIdleReap(
      sample({ idleMs: 90 * MINUTE, cliRssBytes: 220 * MB, treeRssBytes: 6 * GB }),
      CALM,
      LIMITS,
    );
    expect(decision.reap).toBe(false);
  });

  test("reclaims a session whose provider CLI passed the limit, however recently it ran", () => {
    const decision = decideIdleReap(
      sample({ idleMs: 1_000, cliRssBytes: 5 * GB, treeRssBytes: 5 * GB }),
      CALM,
      LIMITS,
    );
    expect(decision.reap).toBe(true);
    expect(decision.reap && decision.reason).toContain("provider CLI");
  });

  test("reclaims exactly at the CLI limit, not only past it", () => {
    expect(decideIdleReap(sample({ cliRssBytes: 4 * GB }), CALM, LIMITS).reap).toBe(true);
    expect(decideIdleReap(sample({ cliRssBytes: 4 * GB - 1 }), CALM, LIMITS).reap).toBe(false);
  });

  test("under memory pressure, reclaims large idle sessions and spares small ones", () => {
    expect(decideIdleReap(sample({ treeRssBytes: 2 * GB }), PRESSURE, LIMITS).reap).toBe(true);
    expect(decideIdleReap(sample({ treeRssBytes: 64 * MB }), PRESSURE, LIMITS).reap).toBe(false);
  });

  test("pressure does not touch a session that only just went idle", () => {
    const justIdle = sample({ idleMs: 15_000, treeRssBytes: 2 * GB });
    expect(decideIdleReap(justIdle, PRESSURE, LIMITS).reap).toBe(false);
  });

  test("an unmeasurable session is not assumed free", () => {
    const unknown = sample({ cliRssBytes: null, treeRssBytes: null, idleMs: 60 * MINUTE });
    // No measurement means the size rules cannot fire, so it survives.
    expect(decideIdleReap(unknown, CALM, LIMITS).reap).toBe(false);
    // Under real pressure there is nothing better to go on, so it is reclaimed.
    expect(decideIdleReap(unknown, PRESSURE, LIMITS).reap).toBe(true);
  });

  test("the backstop reclaims an abandoned session whatever it costs", () => {
    const abandoned = sample({ idleMs: 9 * 60 * MINUTE, cliRssBytes: 40 * MB, treeRssBytes: 40 * MB });
    const decision = decideIdleReap(abandoned, CALM, LIMITS);
    expect(decision.reap).toBe(true);
    expect(decision.reap && decision.reason).toContain("idle for");
  });

  test("ships with a backstop far longer than a working background task", () => {
    expect(DEFAULT_REAP_LIMITS.idleBackstopMs).toBeGreaterThanOrEqual(4 * 60 * MINUTE);
  });
});

describe("planIdleReaps", () => {
  test("returns only the sessions that qualify", () => {
    const plan = planIdleReaps(
      [
        sample({ sessionId: "small" }),
        sample({ sessionId: "leaking", cliRssBytes: 6 * GB, treeRssBytes: 6 * GB }),
      ],
      CALM,
      LIMITS,
    );
    expect(plan.map((entry) => entry.sessionId)).toEqual(["leaking"]);
  });

  test("under pressure the largest tree is reclaimed first", () => {
    const plan = planIdleReaps(
      [
        sample({ sessionId: "medium", treeRssBytes: 1 * GB }),
        sample({ sessionId: "largest", treeRssBytes: 9 * GB }),
        sample({ sessionId: "large", treeRssBytes: 3 * GB }),
      ],
      PRESSURE,
      LIMITS,
    );
    expect(plan.map((entry) => entry.sessionId)).toEqual(["largest", "large", "medium"]);
  });

  test("unmeasured sessions are reclaimed after every measured one", () => {
    const plan = planIdleReaps(
      [
        sample({ sessionId: "unknown", cliRssBytes: null, treeRssBytes: null }),
        sample({ sessionId: "measured", treeRssBytes: 2 * GB }),
      ],
      PRESSURE,
      LIMITS,
    );
    expect(plan.map((entry) => entry.sessionId)).toEqual(["measured", "unknown"]);
  });

  test("ordering is not imposed when there is no pressure to relieve", () => {
    const plan = planIdleReaps(
      [
        sample({ sessionId: "a", cliRssBytes: 5 * GB }),
        sample({ sessionId: "b", cliRssBytes: 9 * GB }),
      ],
      CALM,
      LIMITS,
    );
    expect(plan.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });
});

describe("shouldAnnounceReclaim", () => {
  test("a session reclaimed out from under something says so", () => {
    expect(shouldAnnounceReclaim("idle")).toBe(true);
    expect(shouldAnnounceReclaim("starting")).toBe(true);
    expect(shouldAnnounceReclaim("interrupting")).toBe(true);
  });

  test("a session that already finished is released silently", () => {
    // The defect this guards: every terminal session was having a notice
    // persisted into its transcript a minute after it ended, telling the user
    // that background work did not survive a session that simply completed.
    expect(shouldAnnounceReclaim("done")).toBe(false);
    expect(shouldAnnounceReclaim("error")).toBe(false);
  });
});

describe("formatIdleSurvey", () => {
  test("reports an unreadable footprint as unmeasured rather than as zero", () => {
    const survey = formatIdleSurvey(
      [
        sample({ sessionId: "a", cliRssBytes: null, treeRssBytes: null }),
        sample({ sessionId: "b", cliRssBytes: null, treeRssBytes: null }),
      ],
      CALM,
      LIMITS,
    );
    expect(survey).toContain("idle=2");
    expect(survey).toContain("measured=0");
    expect(survey).toContain("unmeasured=2");
    // "n/a" rather than "0 MB": a zero peak would read as a healthy measurement.
    expect(survey).toContain("peakCli=n/a");
    expect(survey).toContain("peakTree=n/a");
  });

  test("reports the peak of what was measured alongside the limit it is judged against", () => {
    const survey = formatIdleSurvey(
      [
        sample({ sessionId: "a", cliRssBytes: 900 * MB, treeRssBytes: 1 * GB }),
        sample({ sessionId: "b", cliRssBytes: 300 * MB, treeRssBytes: 6 * GB, idleMs: 3 * 60 * MINUTE }),
        sample({ sessionId: "c", cliRssBytes: null, treeRssBytes: null }),
      ],
      PRESSURE,
      LIMITS,
    );
    expect(survey).toContain("idle=3");
    expect(survey).toContain("measured=2");
    expect(survey).toContain("unmeasured=1");
    expect(survey).toContain("pressure=yes");
    expect(survey).toContain("peakCli=900 MB");
    expect(survey).toContain("peakTree=6.0 GB");
    expect(survey).toContain("cliLimit=4.0 GB");
    expect(survey).toContain("oldestIdle=3.0h");
  });
});
