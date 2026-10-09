/**
 * Reports when the backend's event loop was held.
 *
 * One thread serves the UI, every live stream, dictation uploads, and agents'
 * tool calls, so a synchronous stretch anywhere stalls all of them at once. The
 * only trace of that used to be a user saying the app froze. Each report names
 * the tool calls that were running across the stall, which is what points at
 * the offender from a packaged build's backend log.
 */

/** How often the loop is sampled. */
const SAMPLE_MS = 250;
/** Lag past the expected tick that is worth a line in the log. */
const REPORT_LAG_MS = 500;
/** Finished activities are kept this long so a stall can still name them. */
const KEEP_FINISHED_MS = 10_000;
const MAX_TRACKED = 200;

type Activity = { label: string; startedAt: number; endedAt?: number };

const activities: Activity[] = [];

function prune(now: number): void {
  for (let i = activities.length - 1; i >= 0; i--) {
    const endedAt = activities[i]!.endedAt;
    if (endedAt !== undefined && now - endedAt > KEEP_FINISHED_MS) activities.splice(i, 1);
  }
  if (activities.length > MAX_TRACKED) activities.splice(0, activities.length - MAX_TRACKED);
}

/** Mark work a stall report should be able to name. Call the returned function when it ends. */
export function trackActivity(label: string, now: () => number = () => performance.now()): () => void {
  prune(now());
  const activity: Activity = { label, startedAt: now() };
  activities.push(activity);
  return () => {
    activity.endedAt ??= now();
  };
}

/** Labels of activities that overlapped `[from, to]`, each named once. */
export function activitiesDuring(from: number, to: number): string[] {
  const labels = activities
    .filter((activity) => activity.startedAt <= to && (activity.endedAt ?? to) >= from)
    .map((activity) => activity.label);
  return [...new Set(labels)];
}

export function startEventLoopMonitor(
  log: (line: string) => void = (line) => console.warn(line),
  now: () => number = () => performance.now(),
): () => void {
  let expected = now() + SAMPLE_MS;
  const timer = setInterval(() => {
    const at = now();
    const lag = at - expected;
    expected = at + SAMPLE_MS;
    if (lag < REPORT_LAG_MS) return;
    const during = activitiesDuring(at - lag - SAMPLE_MS, at);
    log(`[event-loop] blocked ~${Math.round(lag)}ms${during.length ? ` while running: ${during.join(", ")}` : ""}`);
  }, SAMPLE_MS);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
}
