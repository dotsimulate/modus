import { useEffect, useState } from "react";
import type { MemoryStatus } from "../../../sdk/index";
import { modus } from "../modusClient";

export function SessionLimitSettings() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    modus.getMemoryStatus().then((next) => {
      if (!alive) return;
      setStatus(next);
      setValue(String(next.maxConcurrentSessions));
    }).catch((err: unknown) => {
      if (alive) setError(String(err));
    });
    return () => { alive = false; };
  }, []);

  const limit = Number(value);
  const valid = Number.isSafeInteger(limit) && limit > 0;
  const apply = async () => {
    if (!valid || saving || !status?.concurrencyLimitMutable) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await modus.setMaxConcurrentSessions(limit);
      setStatus(next);
      setValue(String(next.maxConcurrentSessions));
      setSaved(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return <>
    <div className="us-section-title us-section-title--spaced">Backend session capacity</div>
    <div className="us-row">
      <label className="us-row-label" htmlFor="backend-session-limit">Concurrent agents</label>
      <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
      <input id="backend-session-limit" className="us-input" type="number" min={1} step={1} style={{ minWidth: 0, flex: 1 }}
        value={value} disabled={!status?.concurrencyLimitMutable || saving}
        onChange={(event) => { setValue(event.target.value); setSaved(false); }} />
      <button type="button" className="us-pin-btn" onClick={() => void apply()}
        disabled={!status?.concurrencyLimitMutable || !valid || saving || limit === status.maxConcurrentSessions}>
        {saving ? "Applying…" : "Apply"}
      </button>
      </div>
    </div>
    <div className="us-row-hint">
      {status && !status.concurrencyLimitMutable
        ? "This running backend only supports changing the limit at startup. Live adjustment becomes available after loading the updated backend."
        : "Applies immediately across this backend until it restarts. Existing agents keep running, including when the limit is lowered. Memory-pressure protection still applies."}
    </div>
    {status && <div className="us-row-hint">Current limit: {status.maxConcurrentSessions} · Memory: {status.usedGB} / {status.totalGB} GB</div>}
    {saved && <div role="status" className="us-pin-feedback success">Limit applied. Existing sessions were not interrupted.</div>}
    {error && <div role="alert" className="us-pin-feedback error">{error}</div>}
  </>;
}
