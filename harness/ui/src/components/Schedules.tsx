import { useState, useEffect, useCallback } from "react";
import {
  fetchSchedules, fetchScheduleRuns,
  triggerScheduleApi, updateScheduleApi,
} from "../api";
import type { ScheduleInfo, ScheduleRun } from "../api";

type Props = {
  onSelectSession: (id: string) => void;
};

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) {
    const secs = Math.ceil(Math.abs(diff) / 1000);
    return secs < 60 ? `in ${secs}s` : `in ${Math.ceil(secs / 60)}m`;
  }
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function statusClass(s: ScheduleInfo): string {
  if (s.running) return "running";
  if (!s.enabled) return "idle";
  if (s.lastStatus === "error") return "error";
  if (s.lastStatus === "done") return "done";
  return "idle";
}

export function Schedules({ onSelectSession }: Props) {
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [runs, setRuns] = useState<ScheduleRun[]>([]);

  // 1s render tick for smooth countdowns
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll schedules every 5s
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await fetchSchedules();
        if (active) setSchedules(s);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Load runs when expanding a schedule
  useEffect(() => {
    if (!expandedName) { setRuns([]); return; }
    let active = true;
    const load = async () => {
      try {
        const r = await fetchScheduleRuns(expandedName);
        if (active) setRuns(r);
      } catch { /* silent */ }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [expandedName]);

  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    await updateScheduleApi(name, { enabled }).catch(() => {});
    setSchedules(prev => prev.map(s =>
      s.name === name ? { ...s, enabled } : s
    ));
  }, []);

  const handleTrigger = useCallback(async (name: string) => {
    await triggerScheduleApi(name).catch(() => {});
  }, []);

  return (
    <div className="schedules-view">
      <div className="schedules-header">
        <span className="schedules-title">schedules</span>
        <span className="schedules-count">{schedules.length}</span>
      </div>

      {schedules.length === 0 && (
        <div className="schedules-empty">
          no schedules configured
          <div className="schedules-empty-hint">
            create a directory in harness/schedules/ with schedule.json + context.ts
          </div>
        </div>
      )}

      {schedules.map(s => (
        <div key={s.name} className="schedule-item">
          <div
            className="schedule-head"
            onClick={() => setExpandedName(expandedName === s.name ? null : s.name)}
          >
            <span className={`dash-dot dash-dot--${statusClass(s)}`} />
            <span className="schedule-name">{s.name}</span>
            <span className="schedule-desc">{s.description}</span>
            <span className="override-tag">{s.agentProfile}</span>
            <span className="override-tag">{s.interval}</span>
            {s.cycleInterval && <span className="override-tag">cycle: {s.cycleInterval}</span>}
            <span className={`schedule-chevron ${expandedName === s.name ? "open" : ""}`}>&#9662;</span>
          </div>

          <div className="schedule-controls">
            <label className="schedule-toggle">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => handleToggle(s.name, e.target.checked)}
              />
              <span>{s.enabled ? "enabled" : "disabled"}</span>
            </label>
            <button
              className="schedule-trigger-btn"
              onClick={() => handleTrigger(s.name)}
              disabled={s.running}
            >
              {s.running ? "running..." : "run now"}
            </button>
          </div>

          <div className="schedule-meta">
            {s.lastRunAt && <span>last: {timeAgo(s.lastRunAt)}</span>}
            {s.nextRunAt && s.enabled && !s.running && <span>next: {timeAgo(s.nextRunAt)}</span>}
            {s.lastStatus && <span>status: {s.lastStatus}</span>}
            {s.maxRuns && <span>cycle: {s.cycleRunCount}/{s.maxRuns} runs</span>}
            {s.cycleInterval && <span>cycle #{s.cycleNumber}{s.maxCycles ? `/${s.maxCycles}` : ""}</span>}
          </div>

          {/* Expandable run history */}
          {expandedName === s.name && (
            <div className="schedule-runs">
              {runs.length === 0 && (
                <div className="schedules-empty">no runs yet</div>
              )}
              {runs.map(r => (
                <div
                  key={r.id}
                  className={`schedule-run-row ${r.sessionId ? "clickable" : ""}`}
                  onClick={() => r.sessionId && onSelectSession(r.sessionId)}
                >
                  <span className="schedule-run-number">#{r.runNumber}</span>
                  {r.cycleNumber > 1 && <span className="recent-meta">c{r.cycleNumber}</span>}
                  <span className={`dash-dot dash-dot--${
                    r.status === "done" ? "done" : r.status === "error" ? "error" : "running"
                  }`} />
                  <span className="schedule-run-summary">
                    {r.error || r.summary || "..."}
                  </span>
                  <span className="recent-meta">${r.costUsd.toFixed(3)}</span>
                  <span className="recent-meta">
                    {r.startedAt ? timeAgo(r.startedAt) : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
