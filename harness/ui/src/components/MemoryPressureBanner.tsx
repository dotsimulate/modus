import { useEffect, useState } from "react";
import type { MemoryStatus } from "../../../sdk/index";
import { modus } from "../modusClient";
import { describeMemoryPressure } from "../memory-pressure";

/** Matches the backend watchdog, which refreshes the largest-process sample. */
const POLL_MS = 30_000;

export function MemoryPressureBanner() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [dismissedLevel, setDismissedLevel] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => {
      modus.getMemoryStatus()
        .then((next) => { if (alive) setStatus(next); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const notice = describeMemoryPressure(status);
  const level = notice?.level ?? null;

  // A dismissal holds only for the level it was given at: escalating to
  // blocked shows again, and recovering clears it for the next episode.
  useEffect(() => {
    if (!level) setDismissedLevel(null);
  }, [level]);

  if (!notice || dismissedLevel === notice.level) return null;

  return (
    <div className={`update-banner memory-banner ${notice.level === "blocked" ? "critical" : "recommended"}`} role="status">
      <div>
        <strong>{notice.title}</strong>
        <span>{notice.detail}</span>
      </div>
      <div className="update-banner-actions">
        <button type="button" onClick={() => setDismissedLevel(notice.level)}>Dismiss</button>
      </div>
    </div>
  );
}
