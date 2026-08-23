export type ActionLimitDisplay = {
  label: string;
  progressPct: number | null;
};

function displayInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function positiveLimit(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function describeActionRunLimit(
  runCount: number,
  maxRuns: number | undefined,
  hasCycles: boolean,
): ActionLimitDisplay {
  const count = Math.max(0, runCount);
  const scope = hasCycles ? "runs this cycle" : "lifetime runs";
  const limit = positiveLimit(maxRuns);

  if (limit === null) {
    return {
      label: `${displayInteger(count)} ${scope} · unlimited`,
      progressPct: null,
    };
  }

  return {
    label: `${displayInteger(count)} of ${displayInteger(limit)} ${scope}`,
    progressPct: (count / limit) * 100,
  };
}

export function describeActionCycleLimit(
  cycleNumber: number,
  maxCycles: number | undefined,
): ActionLimitDisplay {
  const cycle = Math.max(1, cycleNumber);
  const limit = positiveLimit(maxCycles);

  if (limit === null) {
    return {
      label: `cycle ${displayInteger(cycle)} · unlimited cycles`,
      progressPct: null,
    };
  }

  return {
    label: `cycle ${displayInteger(cycle)} of ${displayInteger(limit)}`,
    progressPct: ((cycle - 1) / limit) * 100,
  };
}
