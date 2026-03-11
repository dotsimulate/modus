import { useState, useEffect, useCallback, useMemo } from "react";
import {
  fetchActions, fetchActionRuns, fetchActionInfo,
  triggerActionApi, updateActionApi, clearActionRunsApi,
  resetActionApi, fetchActionPreferences, reloadActionsApi,
  addTagApi, removeTagApi,
} from "../api";
import type { ActionInfo, ActionRun } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { Markdown } from "./Markdown";

type Props = {
  onSelectSession: (id: string) => void;
  onPeekSession?: (id: string) => void;
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
  if (a.exhausted) return "done";
  if (!a.enabled) return "idle";
  if (a.lastStatus === "error" || a.lastStatus === "failed-verification" || a.lastStatus === "error-transient") return "error";
  return "running"; // enabled + waiting = green dot
}

function runDotStatus(status: string): string {
  if (status === "done") return "done";
  if (status === "error" || status === "failed-verification" || status === "error-transient") return "error";
  if (status === "running") return "streaming";
  return "idle";
}

function runStatusLabel(status: string): string | null {
  if (status === "failed-verification") return "verify failed";
  if (status === "error-transient") return "transient";
  return null;
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
  onPeekSession,
  onClear,
  onReset,
}: {
  runs: ActionRun[];
  action: ActionInfo;
  onSelectSession: (id: string) => void;
  onPeekSession?: (id: string) => void;
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
          <RunRow key={r.id} run={r} onSelect={onSelectSession} onPeek={onPeekSession} />
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
            <RunRow key={r.id} run={r} onSelect={onSelectSession} onPeek={onPeekSession} />
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

function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  // Fallback for non-HTTPS contexts
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

function RunRow({ run, onSelect, onPeek }: { run: ActionRun; onSelect: (id: string) => void; onPeek?: (id: string) => void }) {
  const hasSession = !!run.sessionId;
  const isError = run.status === "error" || run.status === "failed-verification" || run.status === "error-transient";
  const elapsed = run.startedAt && run.completedAt
    ? `${Math.floor((run.completedAt - run.startedAt) / 60000)}:${String(Math.floor(((run.completedAt - run.startedAt) % 60000) / 1000)).padStart(2, "0")}`
    : run.status === "running" ? "..." : null;
  const statusLabel = runStatusLabel(run.status);
  const attempts = run.attempts && run.attempts > 1 ? run.attempts : null;
  const rawError = run.verifyError || run.error;
  const displayError = rawError
    ? rawError.split("\n").filter(l => l.trim() && !l.includes("WARNING:")).pop()
      ?? rawError.split("\n").filter(l => l.trim())[0]
      ?? rawError
    : null;

  return (
    <div
      className={`sched-run-row ${hasSession ? "" : "sched-run-row--no-session"} ${isError ? "sched-run-row--error" : ""}`}
      onClick={() => hasSession && onSelect(run.sessionId!)}
    >
      <div className="sched-run-top">
        <div className="sched-run-summary">
          {displayError || run.summary || "..."}
        </div>
        {rawError && (
          <span
            className="sched-run-copy"
            title="copy full error"
            onClick={(e) => { e.stopPropagation(); copyToClipboard(rawError); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2v2a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2zm2 0h4a2 2 0 0 1 2 2v4h2V2H6v2zM2 6v8h6V6H2z"/></svg>
          </span>
        )}
        {elapsed && <span className="sched-run-elapsed">{elapsed}</span>}
      </div>
      <div className="sched-run-footer">
        <span className="sched-run-num">#{run.runNumber}</span>
        <span className={`dash-dot dash-dot--${runDotStatus(run.status)}`} />
        {statusLabel && <span className="sched-run-status-label">{statusLabel}</span>}
        {attempts && <span className="sched-run-attempts">{attempts} attempts</span>}
        <span className="sched-run-meta">${run.costUsd.toFixed(3)}</span>
        {run.startedAt ? <span className="sched-run-ago">{timeAgo(run.startedAt)}</span> : null}
        {hasSession && onPeek && (
          <button
            className="sched-peek-btn"
            title="peek session"
            onClick={(e) => { e.stopPropagation(); onPeek(run.sessionId!); }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 3C4.5 3 1.7 5.1 1 8c.7 2.9 3.5 5 7 5s6.3-2.1 7-5c-.7-2.9-3.5-5-7-5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none"/>
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" fill="none"/>
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Tab: About ──

function AboutTab({ action }: { action: ActionInfo }) {
  const [desc, setDesc] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetchActionInfo(action.name).then(info => {
      try {
        const config = JSON.parse(info.configSource);
        setDesc(config.longDescription || null);
      } catch { setDesc(null); }
    }).catch(() => setDesc(null));
  }, [action.name]);

  const hasRetry = (action.maxRetries ?? 0) > 0 || (action.maxTransientRetries ?? 0) > 0;
  const hasNotify = action.notify && action.notify.length > 0;
  const hasArtifacts = action.artifacts && action.artifacts.length > 0;
  const hasPipeline = hasRetry || hasNotify || hasArtifacts;

  return (
    <div className="sched-tab-content sched-about-tab">
      {desc && (
        <div className="message-content" style={{ marginBottom: hasPipeline ? 12 : 0 }}>
          <Markdown content={desc} />
        </div>
      )}
      {hasPipeline && (
        <div className="sched-about-pipeline">
          {hasRetry && (
            <div className="sched-about-section">
              <span className="sched-about-heading">retry</span>
              <div className="sched-about-items">
                {(action.maxRetries ?? 0) > 0 && (
                  <span className="sched-about-chip">
                    verify: {action.maxRetries} retries
                    {action.onGatherError === "retry" ? " (incl. gather)" : ""}
                  </span>
                )}
                {(action.maxTransientRetries ?? 0) > 0 && (
                  <span className="sched-about-chip">
                    transient: {action.maxTransientRetries ?? 2}x
                    {action.onTransientFailure === "skip" ? " (skip)" : ""}
                  </span>
                )}
              </div>
            </div>
          )}
          {hasNotify && (
            <div className="sched-about-section">
              <span className="sched-about-heading">notifications</span>
              <div className="sched-about-items">
                {action.notify!.map((n, i) => (
                  <span key={i} className="sched-about-chip">
                    {n.channel} on {Array.isArray(n.on) ? n.on.join(", ") : n.on}
                  </span>
                ))}
              </div>
            </div>
          )}
          {hasArtifacts && (
            <div className="sched-about-section">
              <span className="sched-about-heading">artifacts</span>
              <div className="sched-about-items">
                {action.artifacts!.map((a, i) => (
                  <span key={i} className="sched-about-chip">
                    {a.name} ({a.mime}){a.required === false ? " optional" : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {!desc && !hasPipeline && (
        <div className="sched-runs-empty">no description</div>
      )}
    </div>
  );
}

// ── Tab: Files ──

function FilesTab({ actionName }: { actionName: string }) {
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

type TabKey = "runs" | "about" | "files";

function ActionCard({
  action,
  expanded,
  onToggleExpand,
  onToggleEnabled,
  onTrigger,
  onSelectSession,
  onPeekSession,
  onClearRuns,
  onArchive,
}: {
  action: ActionInfo;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onTrigger: () => void;
  onSelectSession: (id: string) => void;
  onPeekSession?: (id: string) => void;
  onClearRuns: () => void;
  onArchive: () => void;
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
        <button
          className="sched-archive-btn"
          onClick={(e) => { e.stopPropagation(); onArchive(); }}
          title="Archive action"
        >
          arc
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
        {action.exhausted && !action.running && <span className="sched-card-done">complete</span>}
      </div>

      {/* Tags row */}
      <div className="sched-card-tags">
        <span className="override-tag">{action.agentProfile}</span>
        <span className="override-tag">{triggerLabel(action)}</span>
        {action.trigger.type === "interval" && action.trigger.activeHours && (
          <span className="override-tag">{action.trigger.activeHours.start}-{action.trigger.activeHours.end}</span>
        )}
        {action.tags?.filter(t => t !== "archived").map(t => (
          <span key={t} className="override-tag override-tag--user">{t}</span>
        ))}
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
                className={`sched-tab ${tab === "about" ? "sched-tab--active" : ""}`}
                onClick={() => setTab("about")}
              >
                about
              </button>
              <button
                className={`sched-tab ${tab === "files" ? "sched-tab--active" : ""}`}
                onClick={() => setTab("files")}
              >
                files
              </button>
            </div>

            {/* Tab content */}
            {tab === "runs" && (
              <RunsTab
                runs={runs}
                action={action}
                onSelectSession={onSelectSession}
                onPeekSession={onPeekSession}
                onClear={handleClear}
                onReset={skipResetConfirm
                  ? () => handleReset(false)
                  : (skip) => handleReset(skip)
                }
              />
            )}
            {tab === "about" && <AboutTab action={action} />}
            {tab === "files" && <FilesTab actionName={action.name} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Actions View ──

export function Actions({ onSelectSession, onPeekSession }: Props) {
  const { activeUserProfile } = useProfiles();
  const [actions, setActions] = useState<ActionInfo[]>([]);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

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
    reloadActionsApi().then(poll, poll);
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

  const handleArchive = useCallback(async (name: string) => {
    const action = actions.find(a => a.name === name);
    const isArchived = action?.tags?.includes("archived");
    if (isArchived) {
      await removeTagApi(name, "archived").catch(() => {});
      setActions(prev => prev.map(a =>
        a.name === name ? { ...a, tags: (a.tags ?? []).filter(t => t !== "archived") } : a
      ));
    } else {
      await addTagApi(name, "archived").catch(() => {});
      setActions(prev => prev.map(a =>
        a.name === name ? { ...a, tags: [...(a.tags ?? []), "archived"] } : a
      ));
    }
  }, [actions]);

  // Collect all unique tags (excluding "archived")
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const a of actions) {
      for (const t of a.tags ?? []) {
        if (t !== "archived") tags.add(t);
      }
    }
    return Array.from(tags).sort();
  }, [actions]);

  // Split into active and archived
  const activeActions = useMemo(() => {
    let list = actions.filter(a => !a.tags?.includes("archived"));
    if (activeTag) list = list.filter(a => a.tags?.includes(activeTag));
    return list;
  }, [actions, activeTag]);

  const archivedActions = useMemo(() =>
    actions.filter(a => a.tags?.includes("archived")),
  [actions]);

  const runningCount = activeActions.filter(a => a.running).length;
  const enabledCount = activeActions.filter(a => a.enabled).length;

  return (
    <div className="schedules-view">
      {/* Header */}
      <div className="sched-header">
        <span className="sched-header-title">actions</span>
        <span className="sched-header-count">{activeActions.length}</span>
        {runningCount > 0 && (
          <span className="sched-header-running">
            <span className="dash-dot dash-dot--streaming" />
            {runningCount} active
          </span>
        )}
        {enabledCount > 0 && enabledCount < activeActions.length && (
          <span className="sched-header-enabled">{enabledCount} enabled</span>
        )}
      </div>

      {/* Tag filter bar */}
      {allTags.length > 0 && (
        <div className="sched-tag-bar">
          <button
            className={`sched-tag-filter ${!activeTag ? "sched-tag-filter--active" : ""}`}
            onClick={() => setActiveTag(null)}
          >all</button>
          {allTags.map(t => (
            <button
              key={t}
              className={`sched-tag-filter ${activeTag === t ? "sched-tag-filter--active" : ""}`}
              onClick={() => setActiveTag(activeTag === t ? null : t)}
            >{t}</button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {actions.length === 0 && (
        <div className="sched-empty">
          <span>no actions configured</span>
          <span className="sched-empty-hint">
            create a directory in harness/actions/ with action.json + context.ts
          </span>
        </div>
      )}

      {/* Active action cards */}
      <div className="sched-grid">
        {activeActions.map(a => (
          <ActionCard
            key={a.name}
            action={a}
            expanded={expandedName === a.name}
            onToggleExpand={() => setExpandedName(expandedName === a.name ? null : a.name)}
            onToggleEnabled={(enabled) => handleToggle(a.name, enabled)}
            onTrigger={() => handleTrigger(a.name)}
            onSelectSession={onSelectSession}
            onPeekSession={onPeekSession}
            onClearRuns={() => {}}
            onArchive={() => handleArchive(a.name)}
          />
        ))}
      </div>

      {/* Archived section */}
      {archivedActions.length > 0 && (
        <div className="sched-archived-section">
          <button
            className="sched-archived-toggle"
            onClick={() => setShowArchived(!showArchived)}
          >
            <span className={`sched-card-chevron ${showArchived ? "sched-card-chevron--open" : ""}`}>
              {chevron}
            </span>
            {archivedActions.length} archived
          </button>
          {showArchived && (
            <div className="sched-grid">
              {archivedActions.map(a => (
                <ActionCard
                  key={a.name}
                  action={a}
                  expanded={expandedName === a.name}
                  onToggleExpand={() => setExpandedName(expandedName === a.name ? null : a.name)}
                  onToggleEnabled={(enabled) => handleToggle(a.name, enabled)}
                  onTrigger={() => handleTrigger(a.name)}
                  onSelectSession={onSelectSession}
                  onClearRuns={() => {}}
                  onArchive={() => handleArchive(a.name)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
