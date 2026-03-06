import { useState, useEffect, useCallback } from "react";
import {
  fetchActions, fetchActionRuns, fetchActionInfo,
  triggerActionApi, updateActionApi, clearActionRunsApi,
  resetActionApi, fetchActionPreferences,
} from "../api";
import type { ActionInfo, ActionRun } from "../api";
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

function dotStatus(a: ActionInfo): string {
  if (a.running) return "streaming";
  if (!a.enabled) return "idle";
  if (a.lastStatus === "error") return "error";
  return "running"; // enabled + waiting = green dot
}

function runDotStatus(status: string): string {
  if (status === "done") return "done";
  if (status === "error") return "error";
  if (status === "running") return "streaming";
  return "idle";
}

function triggerLabel(a: ActionInfo): string {
  const t = a.trigger;
  if (t.type === "interval") return t.every;
  if (t.type === "webhook") return "webhook";
  if (t.type === "manual") return "manual";
  if (t.type === "action") return `on:${t.source}`;
  return "unknown";
}

const chevron = (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
    <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

// ── Cycle/Run Summary ──

function CycleInfo({ action }: { action: ActionInfo }) {
  const hasCycles = !!action.cycleInterval;
  const runs = action.maxRuns
    ? `${action.cycleRunCount}/${action.maxRuns}`
    : `${action.cycleRunCount}`;

  if (!hasCycles) {
    return <span className="sched-cycle-info">{runs} runs</span>;
  }

  const cycle = action.maxCycles
    ? `${action.cycleNumber}/${action.maxCycles}`
    : `${action.cycleNumber}`;

  return (
    <span className="sched-cycle-info">
      cycle {cycle} · {runs} runs · {action.cycleInterval} reset
    </span>
  );
}

// ── Tab: Runs ──

function RunsTab({
  runs,
  action,
  onSelectSession,
  onClear,
  onReset,
}: {
  runs: ActionRun[];
  action: ActionInfo;
  onSelectSession: (id: string) => void;
  onClear: () => void;
  onReset: (skipConfirm: boolean) => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Group runs by cycle
  const currentCycle = action.cycleNumber;
  const currentRuns = runs.filter(r => r.cycleNumber === currentCycle);
  const pastRuns = runs.filter(r => r.cycleNumber !== currentCycle);

  return (
    <div className="sched-tab-content">
      {/* Current cycle runs */}
      <div className="sched-runs-section">
        <div className="sched-runs-section-header">
          <span>current cycle</span>
          <CycleInfo action={action} />
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
            disabled={action.running}
          >
            reset action
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

function RunRow({ run, onSelect }: { run: ActionRun; onSelect: (id: string) => void }) {
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

function InfoTab({ actionName }: { actionName: string }) {
  const [info, setInfo] = useState<{ contextSource: string; configSource: string } | null>(null);

  useEffect(() => {
    fetchActionInfo(actionName).then(setInfo).catch(() => {});
  }, [actionName]);

  if (!info) return <div className="sched-tab-content sched-runs-empty">loading...</div>;

  return (
    <div className="sched-tab-content sched-info-tab">
      <div className="sched-info-section">
        <span className="sched-info-label">action.json</span>
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
      aria-label={checked ? "Disable action" : "Enable action"}
    >
      <span className="sched-switch-knob" />
    </button>
  );
}

// ── Action Meters (3 rows: cycle, runs, next run) ──

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

function ActionMeters({ action }: { action: ActionInfo }) {
  const off = !action.enabled;

  // Row 1: cycles
  const hasCycles = !!action.cycleInterval;
  const cycleLabel = hasCycles
    ? action.maxCycles ? `cycle ${action.cycleNumber}/${action.maxCycles}` : `cycle ${action.cycleNumber}`
    : "";
  const cyclePct = hasCycles && action.maxCycles
    ? ((action.cycleNumber - 1) / action.maxCycles) * 100
    : 0;

  // Row 2: runs in current cycle
  const runLabel = action.maxRuns
    ? `${action.cycleRunCount}/${action.maxRuns} runs`
    : `${action.cycleRunCount} runs`;
  const runPct = action.maxRuns
    ? (action.cycleRunCount / action.maxRuns) * 100
    : 0;

  // Row 3: countdown (only meaningful for interval triggers)
  let nextLabel = "";
  let nextPct = 0;
  if (off) {
    nextLabel = "paused";
  } else if (action.running) {
    nextLabel = "running";
    nextPct = 100;
  } else if (action.trigger.type === "interval" && action.nextRunAt) {
    const intervalMs = parseIntervalMs(action.trigger.every);
    if (intervalMs > 0) {
      const remaining = Math.max(0, action.nextRunAt - Date.now());
      nextLabel = `next ${countdown(action.nextRunAt)}`;
      nextPct = Math.min(100, Math.max(0, ((intervalMs - remaining) / intervalMs) * 100));
    }
  } else if (action.trigger.type !== "interval") {
    nextLabel = action.trigger.type;
  }

  return (
    <div className={`sched-meters ${off ? "sched-meters--off" : ""}`}>
      <MeterRow label={cycleLabel || (hasCycles ? `${action.cycleInterval} reset` : "no cycles")} pct={cyclePct} kind="cycle" />
      <MeterRow label={runLabel} pct={runPct} kind="runs" />
      <MeterRow label={nextLabel || "--"} pct={nextPct} kind="next" />
    </div>
  );
}

// ── Action Card ──

type TabKey = "runs" | "info";

function ActionCard({
  action,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onTrigger,
  onSelectSession,
  onClearRuns,
}: {
  action: ActionInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onTrigger: () => void;
  onSelectSession: (id: string) => void;
  onClearRuns: () => void;
}) {
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [tab, setTab] = useState<TabKey>("runs");
  const [skipResetConfirm, setSkipResetConfirm] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    const load = async () => {
      try {
        const r = await fetchActionRuns(action.name);
        if (active) setRuns(r);
      } catch { /* silent */ }
    };
    load();
    fetchActionPreferences(action.name).then(prefs => {
      if (active && prefs.skipResetConfirm) setSkipResetConfirm(true);
    }).catch(() => {});
    const interval = setInterval(load, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [expanded, action.name]);

  const handleClear = async () => {
    await clearActionRunsApi(action.name).catch(() => {});
    setRuns([]);
    onClearRuns();
  };

  const handleReset = async (dontAskAgain: boolean) => {
    await resetActionApi(action.name, dontAskAgain).catch(() => {});
    setRuns([]);
    if (dontAskAgain) setSkipResetConfirm(true);
  };

  const dot = dotStatus(action);

  return (
    <div className={`sched-card ${expanded ? "sched-card--expanded" : ""}`} onClick={onToggleExpand}>
      {/* Controls — top right stamp */}
      <div className="sched-card-stamp" onClick={(e) => e.stopPropagation()}>
        <ToggleSwitch
          checked={action.enabled}
          onChange={(v) => onToggleEnabled(v)}
        />
        <button
          className="sched-trigger-btn"
          onClick={(e) => { e.stopPropagation(); onTrigger(); }}
          disabled={action.running}
        >
          {action.running ? "..." : "run"}
        </button>
      </div>

      {/* Header */}
      <div className="sched-card-header">
        <span className={`dash-dot dash-dot--${dot}`} />
        <span className="sched-card-name">{action.name}</span>
        <span className={`sched-card-chevron ${expanded ? "sched-card-chevron--open" : ""}`}>
          {chevron}
        </span>
        {action.running && <span className="sched-card-live">running</span>}
      </div>

      {/* Tags row */}
      <div className="sched-card-tags">
        <span className="override-tag">{action.agentProfile}</span>
        <span className="override-tag">{triggerLabel(action)}</span>
        {action.trigger.type === "interval" && action.trigger.activeHours && (
          <span className="override-tag">{action.trigger.activeHours.start}-{action.trigger.activeHours.end}</span>
        )}
      </div>

      {/* Description */}
      <div className="sched-card-desc">{action.description}</div>

      {/* Meters */}
      <ActionMeters action={action} />

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
                action={action}
                onSelectSession={onSelectSession}
                onClear={handleClear}
                onReset={skipResetConfirm
                  ? () => handleReset(false)
                  : (skip) => handleReset(skip)
                }
              />
            )}
            {tab === "info" && <InfoTab actionName={action.name} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Actions View ──

export function Actions({ onSelectSession }: Props) {
  const { activeUserProfile } = useProfiles();
  const [actions, setActions] = useState<ActionInfo[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);

  // 1s render tick for smooth countdowns
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll actions every 2s, scoped to active user profile
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const a = await fetchActions(activeUserProfile);
        if (active) setActions(a);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [activeUserProfile]);

  const handleToggle = useCallback(async (name: string, enabled: boolean) => {
    await updateActionApi(name, { enabled }).catch(() => {});
    setActions(prev => prev.map(a =>
      a.name === name ? { ...a, enabled } : a
    ));
  }, []);

  const handleTrigger = useCallback(async (name: string) => {
    await triggerActionApi(name, activeUserProfile).catch(() => {});
  }, [activeUserProfile]);

  const runningCount = actions.filter(a => a.running).length;
  const enabledCount = actions.filter(a => a.enabled).length;

  return (
    <div className="schedules-view">
      {/* Header */}
      <div className="sched-header">
        <span className="sched-header-title">actions</span>
        <span className="sched-header-count">{actions.length}</span>
        {runningCount > 0 && (
          <span className="sched-header-running">
            <span className="dash-dot dash-dot--streaming" />
            {runningCount} active
          </span>
        )}
        {enabledCount > 0 && enabledCount < actions.length && (
          <span className="sched-header-enabled">{enabledCount} enabled</span>
        )}
      </div>

      {/* Empty state */}
      {actions.length === 0 && (
        <div className="sched-empty">
          <span>no actions configured</span>
          <span className="sched-empty-hint">
            create a directory in harness/actions/ with action.json + context.ts
          </span>
        </div>
      )}

      {/* Action cards */}
      <div className="sched-grid">
        {actions.map(a => (
          <ActionCard
            key={a.name}
            action={a}
            expanded={expandedName === a.name}
            onToggleExpand={() => setExpandedName(expandedName === a.name ? null : a.name)}
            onToggleEnabled={(enabled) => handleToggle(a.name, enabled)}
            onTrigger={() => handleTrigger(a.name)}
            onSelectSession={onSelectSession}
            onClearRuns={() => {}}
          />
        ))}
      </div>
    </div>
  );
}
