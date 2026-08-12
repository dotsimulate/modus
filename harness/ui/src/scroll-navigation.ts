const TURN_SNAP_FRACTION = 0.012;

export type SpineNavigationTick = {
  key: string;
  startFraction: number;
};

export type SpineClickTarget = {
  key: string;
  within: number;
};

/** Resolve a click to the span that owns it, preserving position in tall items. */
export function resolveSpineClickTarget(
  ticks: readonly SpineNavigationTick[],
  turns: readonly SpineNavigationTick[],
  rawFraction: number,
): SpineClickTarget | null {
  if (!ticks.length) return null;
  const fraction = Math.max(0, Math.min(1, rawFraction));

  let nearestTurn: SpineNavigationTick | null = null;
  let turnDistance = Infinity;
  for (const turn of turns) {
    const distance = Math.abs(fraction - turn.startFraction);
    if (distance < turnDistance) {
      turnDistance = distance;
      nearestTurn = turn;
    }
  }
  if (nearestTurn && turnDistance <= TURN_SNAP_FRACTION) {
    return { key: nearestTurn.key, within: 0 };
  }

  let index = 0;
  for (let i = 1; i < ticks.length; i++) {
    const candidate = ticks[i];
    if (!candidate) continue;
    if (candidate.startFraction > fraction) break;
    index = i;
  }
  const tick = ticks[index] ?? ticks[0];
  if (!tick) return null;
  const end = ticks[index + 1]?.startFraction ?? 1;
  const span = Math.max(end - tick.startFraction, Number.EPSILON);
  const within = Math.max(0, Math.min(1, (fraction - tick.startFraction) / span));
  return { key: tick.key, within };
}

export function calculateScrollTarget(
  itemOffset: number,
  itemHeight: number,
  within: number,
  padding: number,
  max: number,
): number {
  const position = Math.max(0, Math.min(1, within));
  const target = itemOffset + Math.max(itemHeight - 1, 0) * position - padding;
  return Math.min(Math.max(0, target), Math.max(0, max));
}
