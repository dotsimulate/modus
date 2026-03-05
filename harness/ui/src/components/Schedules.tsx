import { useState, useEffect, useCallback } from "react";
import {
  fetchSchedules, fetchScheduleRuns, fetchScheduleInfo,
  triggerScheduleApi, updateScheduleApi, clearScheduleRunsApi,
  resetScheduleApi, fetchSchedulePreferences,
} from "../api";
import type { ScheduleInfo, ScheduleRun } from "../api";
import { useProfiles } from "../providers/ProfileProvider";

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

function countdown(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const secs = Math.ceil(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.ceil(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function parseIntervalMs(s: string): number {
  const m = s.match(/^(\d+)(s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === "s") return n * 1000;
  if (m[2] === "m") return n * 60_000;
  return n * 3_600_000;
}

function dotStatus(s: ScheduleInfo): string {
  if (s.running) return "streaming";
  if (!s.enabled) return "idle";
  if (s.lastStatus === "error") return "error";
  return "running"; // enabled + waiting = green dot
}

function runDotStatus(status: string): string {
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "running") return "streaming";
  return "idle";
}

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

// ── Cycle/Run Summary ──

function CycleInfo({ schedule }: { schedule: ScheduleInfo }) {
  const hasCycles = !!schedule.cycleInterval;
  const runs = schedule.maxRuns
    ? `${schedule.cycleRunCount}/${schedule.maxRuns}`
    : `${schedule.cycleRunCount}`;

  if (!hasCycles) {
    return <span className="sched-cycle-info">{runs} runs</span>;
  }

  const cycle = schedule.maxCycles
    ? `${schedule.cycleNumber}/${schedule.maxCycles}`
    : `${schedule.cycleNumber}`;

  return (
    <span className="sched-cycle-info">
      cycle {cycle} · {runs} runs · {schedule.cycleInterval} reset
    </span>
  );
}

// ── Tab: Runs ──

function RunsTab({
  runs,
  schedule,
  onSelectSession,
  onClear,
  onReset,
}: {
  runs: ScheduleRun[];
  schedule: ScheduleInfo;
  onSelectSession: (id: string) => void;
  onClear: () => void;
  onReset: (skipConfirm: boolean) => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Group runs by cycle
  const currentCycle = schedule.cycleNumber;
  const currentRuns = runs.filter(r => r.cycleNumber === currentCycle);
  const pastRuns = runs.filter(r => r.cycleNumber !== currentCycle);

  return (
    <div className="sched-tab-content">
      {/* Current cycle runs */}
      <div className="sched-runs-section">
        <div className="sched-runs-section-header">
          <span>current cycle</span>
          <CycleInfo schedule={schedule} />
        </div>
        {currentRuns.length === 0 && (
          <div className="sched-runs-empty">no runs in this cycle</div>
        )}
        {currentRuns.map(r => (
          <RunRow key={r.id} run={r} onSelect={onSelectSession} />
        ))}
      </div>

      {/* Past cycle runs */}
      {pastRuns.length > 0 && (
        <div className="sched-runs-section">
          <div className="sched-runs-section-header">
            <span>previous cycles</span>
            <span className="sched-runs-count">{pastRuns.length}</span>
          </div>
          {pastRuns.map(r => (
            <RunRow key={r.id} run={r} onSelect={onSelectSession} />
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="sched-runs-actions">
        {runs.length > 0 && (
          <button className="sched-clear-btn" onClick={onClear}>
            clear history
          </button>
        )}
        {!confirmingReset ? (
          <button
            className="sched-clear-btn sched-reset-btn"
            onClick={() => setConfirmingReset(true)}
            disabled={schedule.running}
          >
            reset schedule
          </button>
        ) : (
          <div className="sched-reset-confirm">
            <span className="sched-reset-warn">reset all counters and history?</span>
            <label className="sched-reset-checkbox">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              don't ask again
            </label>
            <div className="sched-reset-confirm-btns">
              <button
                className="sched-clear-btn sched-reset-btn"
                onClick={() => { onReset(dontAskAgain); setConfirmingReset(false); }}
              >
                confirm
              </button>
              <button
                className="sched-clear-btn"
                onClick={() => { setConfirmingReset(false); setDontAskAgain(false); }}
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, onSelect }: { run: ScheduleRun; onSelect: (id: string) => void }) {
  return (
    <button
      className={`sched-run-row ${run.sessionId ? "" : "sched-run-row--no-session"}`}
      onClick={() => run.sessionId && onSelect(run.sessionId)}
      disabled={!run.sessionId}
    >
      <span className="sched-run-num">#{run.runNumber}</span>
      <span className={`dash-dot dash-dot--${runDotStatus(run.status)}`} />
      <span className="sched-run-text">
        {run.error || run.summary || "..."}
      </span>
      <span className="sched-run-meta">${run.costUsd.toFixed(3)}</span>
      <span className="sched-run-meta">
        {run.startedAt ? timeAgo(run.startedAt) : ""}
      </span>
    </button>
  );
}

// ── Tab: Info ──

function InfoTab({ scheduleName }: { scheduleName: string }) {
  const [info, setInfo] = useState<{ contextSource: string; configSource: string } | null>(null);

  useEffect(() => {
    fetchScheduleInfo(scheduleName).then(setInfo).catch(() => {});
  }, [scheduleName]);

  if (!info) return <div className="sched-tab-content sched-runs-empty">loading...</div>;

  return (
    <div className="sched-tab-content sched-info-tab">
      <div className="sched-info-section">
        <span className="sched-info-label">schedule.json</span>
        <pre className="sched-info-code">{info.configSource || "not found"}</pre>
      </div>
      <div className="sched-info-section">
        <span className="sched-info-label">context.ts</span>
        <pre className="sched-info-code">{info.contextSource || "not found"}</pre>
      </div>
    </div>
  );
}

// ── Toggle Switch ──

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`sched-switch ${checked ? "sched-switch--on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      aria-label={checked ? "Disable schedule" : "Enable schedule"}
    >
      <span className="sched-switch-knob" />
    </button>
  );
}

// ── Schedule Meters (3 rows: schedule, cycle, next run) ──

function MeterRow({ label, pct, kind }: { label: string; pct: number; kind: "cycle" | "runs" | "next" }) {
  return (
    <div className="sched-meter-row">
      <span className="sched-meter-label">{label}</span>
      <div className="sched-progress">
        <div className={`sched-progress-fill sched-progress-fill--${kind}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function ScheduleMeters({ schedule }: { schedule: ScheduleInfo }) {
  const off = !schedule.enabled;

  // Row 1: schedule-level cycles
  const hasCycles = !!schedule.cycleInterval;
  const cycleLabel = hasCycles
    ? schedule.maxCycles ? `cycle ${schedule.cycleNumber}/${schedule.maxCycles}` : `cycle ${schedule.cycleNumber}`
    : "";
  const cyclePct = hasCycles && schedule.maxCycles
    ? ((schedule.cycleNumber - 1) / schedule.maxCycles) * 100
    : 0;

  // Row 2: runs in current cycle
  const runLabel = schedule.maxRuns
    ? `${schedule.cycleRunCount}/${schedule.maxRuns} runs`
    : `${schedule.cycleRunCount} runs`;
  const runPct = schedule.maxRuns
    ? (schedule.cycleRunCount / schedule.maxRuns) * 100
    : 0;

  // Row 3: countdown to next run
  let nextLabel = "";
  let nextPct = 0;
  const intervalMs = parseIntervalMs(schedule.interval);
  if (off) {
    nextLabel = "paused";
  } else if (schedule.running) {
    nextLabel = "running";
    nextPct = 100;
  } else if (schedule.nextRunAt && intervalMs > 0) {
    const remaining = Math.max(0, schedule.nextRunAt - Date.now());
    nextLabel = `next ${countdown(schedule.nextRunAt)}`;
    nextPct = Math.min(100, Math.max(0, ((intervalMs - remaining) / intervalMs) * 100));
  }

  return (
    <div className={`sched-meters ${off ? "sched-meters--off" : ""}`}>
      <MeterRow label={cycleLabel || (hasCycles ? `${schedule.cycleInterval} reset` : "no cycles")} pct={cyclePct} kind="cycle" />
      <MeterRow label={runLabel} pct={runPct} kind="runs" />
      <MeterRow label={nextLabel || "--"} pct={nextPct} kind="next" />
    </div>
  );
}

// ── Schedule Card ──

type TabKey = "runs" | "info";

function ScheduleCard({
  schedule,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onTrigger,
  onSelectSession,
  onClearRuns,
}: {
  schedule: ScheduleInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onTrigger: () => void;
  onSelectSession: (id: string) => void;
  onClearRuns: () => void;
}) {
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [tab, setTab] = useState<TabKey>("runs");
  const [skipResetConfirm, setSkipResetConfirm] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    const load = async () => {
      try {
        const r = await fetchScheduleRuns(schedule.name);
        if (active) setRuns(r);
      } catch { /* silent */ }
    };
    load();
    // Also load preferences
    fetchSchedulePreferences(schedule.name).then(prefs => {
      if (active && prefs.skipResetConfirm) setSkipResetConfirm(true);
    }).catch(() => {});
    const interval = setInterval(load, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [expanded, schedule.name]);

  const handleClear = async () => {
    await clearScheduleRunsApi(schedule.name).catch(() => {});
    setRuns([]);
    onClearRuns();
  };

  const handleReset = async (dontAskAgain: boolean) => {
    await resetScheduleApi(schedule.name, dontAskAgain).catch(() => {});
    setRuns([]);
    if (dontAskAgain) setSkipResetConfirm(true);
  };

  const dot = dotStatus(schedule);

  return (
    <div className={`sched-card ${expanded ? "sched-card--expanded" : ""}`} onClick={onToggleExpand}>
      {/* Controls — top right stamp */}
      <div className="sched-card-stamp" onClick={(e) => e.stopPropagation()}>
        <ToggleSwitch
          checked={schedule.enabled}
          onChange={(v) => onToggleEnabled(v)}
        />
        <button
          className="sched-trigger-btn"
          onClick={(e) => { e.stopPropagation(); onTrigger(); }}
          disabled={schedule.running}
        >
          {schedule.running ? "..." : "run"}
        </button>
      </div>

      {/* Header */}
      <div className="sched-card-header">
        <span className={`dash-dot dash-dot--${dot}`} />
        <span className="sched-card-name">{schedule.name}</span>
        <span className={`sched-card-chevron ${expanded ? "sched-card-chevron--open" : ""}`}>
          {chevron}
        </span>
        {schedule.running && <span className="sched-card-live">running</span>}
      </div>

      {/* Tags row */}
      <div className="sched-card-tags">
        <span className="override-tag">{schedule.agentProfile}</span>
        <span className="override-tag">{schedule.interval}</span>
        {schedule.activeHours && (
          <span className="override-tag">{schedule.activeHours.start}-{schedule.activeHours.end}</span>
        )}
      </div>

      {/* Description — under stamp, above meters */}
      <div className="sched-card-desc">{schedule.description}</div>

      {/* Meters */}
      <ScheduleMeters schedule={schedule} />

      {/* Expandable detail panel */}
      <div className={`panel-collapse ${expanded ? "panel-collapse--open" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="panel-collapse-clip">
          <div className="sched-detail">
            {/* Tab bar */}
            <div className="sched-tabs">
              <button
                className={`sched-tab ${tab === "runs" ? "sched-tab--active" : ""}`}
                onClick={() => setTab("runs")}
              >
                runs
              </button>
              <button
                className={`sched-tab ${tab === "info" ? "sched-tab--active" : ""}`}
                onClick={() => setTab("info")}
              >
                info
              </button>
            </div>

            {/* Tab content */}
            {tab === "runs" && (
              <RunsTab
                runs={runs}
                schedule={schedule}
                onSelectSession={onSelectSession}
                onClear={handleClear}
                onReset={skipResetConfirm
                  ? () => handleReset(false)
                  : (skip) => handleReset(skip)
                }
              />
            )}
            {tab === "info" && <InfoTab scheduleName={schedule.name} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Schedules View ──

export function Schedules({ onSelectSession }: Props) {
  const { activeUserProfile } = useProfiles();
  const [schedules, setSchedules] = useState<ScheduleInfo[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);

  // 1s render tick for smooth countdowns
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll schedules every 2s, scoped to active user profile
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await fetchSchedules(activeUserProfile);
        if (active) setSchedules(s);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [activeUserProfile]);

  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    await updateScheduleApi(name, { enabled }).catch(() => {});
    setSchedules(prev => prev.map(s =>
      s.name === name ? { ...s, enabled } : s
    ));
  }, []);

  const handleTrigger = useCallback(async (name: string) => {
    await triggerScheduleApi(name, activeUserProfile).catch(() => {});
  }, [activeUserProfile]);

  const runningCount = schedules.filter(s => s.running).length;
  const enabledCount = schedules.filter(s => s.enabled).length;

  return (
    <div className="schedules-view">
      {/* Header */}
      <div className="sched-header">
        <span className="sched-header-title">schedules</span>
        <span className="sched-header-count">{schedules.length}</span>
        {runningCount > 0 && (
          <span className="sched-header-running">
            <span className="dash-dot dash-dot--streaming" />
            {runningCount} active
          </span>
        )}
        {enabledCount > 0 && enabledCount < schedules.length && (
          <span className="sched-header-enabled">{enabledCount} enabled</span>
        )}
      </div>

      {/* Empty state */}
      {schedules.length === 0 && (
        <div className="sched-empty">
          <span>no schedules configured</span>
          <span className="sched-empty-hint">
            create a directory in harness/schedules/ with schedule.json + context.ts
          </span>
        </div>
      )}

      {/* Schedule cards */}
      <div className="sched-grid">
        {schedules.map(s => (
          <ScheduleCard
            key={s.name}
            schedule={s}
            expanded={expandedName === s.name}
            onToggleExpand={() => setExpandedName(expandedName === s.name ? null : s.name)}
            onToggleEnabled={(enabled) => handleToggle(s.name, enabled)}
            onTrigger={() => handleTrigger(s.name)}
            onSelectSession={onSelectSession}
            onClearRuns={() => {}}
          />
        ))}
      </div>
    </div>
  );
}
