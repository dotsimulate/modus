export type VirtualHeightUpdate = {
  changed: boolean;
  previous: number | undefined;
};

/** Refresh mounted rows immediately: unchanged DOM sizes do not fire ResizeObserver again. */
export function resetVirtualHeights(
  heights: Map<string, number>,
  measuredKeys: Set<string>,
  mounted: Iterable<readonly [string, number]>,
): void {
  heights.clear();
  measuredKeys.clear();
  for (const [key, height] of mounted) recordVirtualHeight(heights, measuredKeys, key, height);
}

/**
 * Record a mounted virtual row's height without allowing teardown or hidden
 * layout states to collapse previously valid geometry.
 */
export function recordVirtualHeight(
  heights: Map<string, number>,
  measuredKeys: Set<string>,
  key: string,
  height: number,
): VirtualHeightUpdate {
  const previous = heights.get(key);
  if (!Number.isFinite(height) || height <= 0) return { changed: false, previous };
  if (measuredKeys.has(key) && previous === height) return { changed: false, previous };
  if (previous != null && Math.abs(height - previous) < 5) return { changed: false, previous };

  heights.set(key, height);
  measuredKeys.add(key);
  return { changed: true, previous };
}
