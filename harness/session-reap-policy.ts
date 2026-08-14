/**
 * Idle session reclamation policy.
 *
 * Reclaiming an idle session kills the provider CLI and every process below it,
 * which includes any background work the agent left running. Time since the
 * last event does not predict whether that is worth doing, so the decision is
 * made from what the session actually costs:
 *
 *   1. The provider CLI's own footprint. A runaway agent runtime shows up here
 *      and nowhere else, and it is bounded by the same limit that
 *      `MG_MAX_HEAP_MB` used to enforce through `NODE_OPTIONS`.
 *   2. System memory pressure. Under pressure the largest idle trees go first,
 *      regardless of what they contain — an unresponsive machine costs more
 *      than an interrupted build.
 *   3. An absolute backstop, so abandoned sessions cannot accumulate across a
 *      long uptime.
 *
 * Subprocesses the agent launched are counted in `treeRssBytes` but never in
 * `cliRssBytes`. That separation is the point: a session running a 6 GB build
 * is not a leaking session, and only rule 2 may touch it.
 *
 * Every function here is pure so the policy can be tested without a database,
 * a provider, or a live process table.
 */

export type ReapLimits = {
  /** Provider CLI footprint that is treated as runaway on its own. */
  cliRssLimitBytes: number;
  /** Smallest tree worth reclaiming when the system is under memory pressure. */
  pressureRssFloorBytes: number;
  /** Idle time a session must reach before pressure may reclaim it. */
  pressureGraceMs: number;
  /** Idle time after which a session is reclaimed whatever it costs. */
  idleBackstopMs: number;
};

export type IdleSessionSample = {
  sessionId: string;
  /** Milliseconds since the session last produced an event. */
  idleMs: number;
  /**
   * Resident bytes held by the provider CLI processes in this session's tree,
   * or null when the process table could not be read.
   */
  cliRssBytes: number | null;
  /** Resident bytes across the session's whole process tree, or null. */
  treeRssBytes: number | null;
};

export type ReapContext = {
  /** Whether system memory usage has crossed the configured pressure threshold. */
  underPressure: boolean;
};

export type ReapDecision =
  | { reap: false }
  | { reap: true; reason: string };

export const DEFAULT_REAP_LIMITS: ReapLimits = {
  cliRssLimitBytes: 4096 * 1024 * 1024,
  pressureRssFloorBytes: 512 * 1024 * 1024,
  pressureGraceMs: 2 * 60_000,
  idleBackstopMs: 8 * 60 * 60_000,
};

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}m`;
}

/**
 * Decide whether one idle session should be reclaimed.
 *
 * A null footprint means the process table was unreadable, not that the
 * session is free. Rules that need a measurement are skipped in that case and
 * only the backstop applies.
 */
export function decideIdleReap(
  sample: IdleSessionSample,
  ctx: ReapContext,
  limits: ReapLimits = DEFAULT_REAP_LIMITS,
): ReapDecision {
  if (sample.cliRssBytes !== null && sample.cliRssBytes >= limits.cliRssLimitBytes) {
    return {
      reap: true,
      reason: `provider CLI holding ${formatBytes(sample.cliRssBytes)} ` +
        `(limit ${formatBytes(limits.cliRssLimitBytes)})`,
    };
  }

  if (ctx.underPressure && sample.idleMs >= limits.pressureGraceMs) {
    // With no measurement under real pressure, idleness is the only ordering
    // signal left and reclaiming beats another out-of-memory crash.
    if (sample.treeRssBytes === null) {
      return { reap: true, reason: "system memory pressure (process size unknown)" };
    }
    if (sample.treeRssBytes >= limits.pressureRssFloorBytes) {
      return {
        reap: true,
        reason: `system memory pressure, session holding ${formatBytes(sample.treeRssBytes)}`,
      };
    }
  }

  if (sample.idleMs >= limits.idleBackstopMs) {
    return { reap: true, reason: `idle for ${formatDuration(sample.idleMs)}` };
  }

  return { reap: false };
}

/**
 * Whether a reclamation is worth telling the user about.
 *
 * A session already in a terminal state has nothing left to interrupt — its
 * process releasing a minute later is the ordinary end of its lifecycle, and
 * announcing it would append a notice to a transcript that simply finished.
 * Every other status is reclaimed out from under something, which is exactly
 * what the user cannot otherwise see.
 */
export function shouldAnnounceReclaim(previousStatus: string): boolean {
  return previousStatus !== "done" && previousStatus !== "error";
}

/**
 * One-line survey of what a reap sweep measured.
 *
 * The policy treats an unreadable footprint as unknown and falls through to the
 * backstop, which from the outside is indistinguishable from "measured, and
 * nothing was over the limit". Recording the split is what tells those apart
 * without waiting for a threshold to be crossed.
 */
export function formatIdleSurvey(
  samples: IdleSessionSample[],
  ctx: ReapContext,
  limits: ReapLimits = DEFAULT_REAP_LIMITS,
): string {
  const measured = samples.filter((s) => s.cliRssBytes !== null && s.treeRssBytes !== null);
  const peakCli = measured.reduce((max, s) => Math.max(max, s.cliRssBytes ?? 0), 0);
  const peakTree = measured.reduce((max, s) => Math.max(max, s.treeRssBytes ?? 0), 0);
  const oldest = samples.reduce((max, s) => Math.max(max, s.idleMs), 0);
  return `idle=${samples.length} measured=${measured.length} `
    + `unmeasured=${samples.length - measured.length} pressure=${ctx.underPressure ? "yes" : "no"} `
    + `peakCli=${measured.length > 0 ? formatBytes(peakCli) : "n/a"} `
    + `peakTree=${measured.length > 0 ? formatBytes(peakTree) : "n/a"} `
    + `cliLimit=${formatBytes(limits.cliRssLimitBytes)} oldestIdle=${formatDuration(oldest)}`;
}

export type ReapPlanEntry = { sessionId: string; reason: string };

/**
 * Decide across all idle sessions at once.
 *
 * Ordering matters only under pressure, where the largest trees are reclaimed
 * first so the fewest sessions are disturbed to recover the most memory.
 * Sessions with an unknown footprint sort last, after every measured one.
 */
export function planIdleReaps(
  samples: IdleSessionSample[],
  ctx: ReapContext,
  limits: ReapLimits = DEFAULT_REAP_LIMITS,
): ReapPlanEntry[] {
  const plan: ReapPlanEntry[] = [];
  for (const sample of samples) {
    const decision = decideIdleReap(sample, ctx, limits);
    if (decision.reap) plan.push({ sessionId: sample.sessionId, reason: decision.reason });
  }
  if (!ctx.underPressure) return plan;

  const sizeOf = new Map(samples.map((s) => [s.sessionId, s.treeRssBytes]));
  return plan.sort((a, b) => {
    const left = sizeOf.get(a.sessionId);
    const right = sizeOf.get(b.sessionId);
    if (left === right) return 0;
    if (left === null || left === undefined) return 1;
    if (right === null || right === undefined) return -1;
    return right - left;
  });
}
