import { useState, useEffect, useCallback } from "react";
import { modus } from "../modusClient";
import type { MissionListItem, MissionRunSummary, MissionStepRunSummary } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";

function missionDotStatus(run: MissionRunSummary | undefined): string {
  if (!run) return "idle";
  if (run.status === "running") return "streaming";
  if (run.status === "pending") return "running";
  if (run.status === "paused") return "draft";
  if (run.status === "completed") return "done";
  if (run.status === "error") return "error";
  return "idle";
}

function stepDotStatus(status: string): string {
  if (status === "running") return "streaming";
  if (status === "completed" || status === "skipped") return "done";
  if (status === "failed") return "error";
  return "idle";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function elapsed(startTs: number, endTs?: number | null): string {
  const ms = (endTs ?? Date.now()) - startTs;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

function getActiveRun(runs: MissionRunSummary[], name: string): MissionRunSummary | undefined {
  const mine = runs.filter(r => r.missionName === name);
  const live = mine.find(r => r.status === "running" || r.status === "pending" || r.status === "paused");
  if (live) return live;
  return mine.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function StepTracker({ steps }: { steps: MissionStepRunSummary[] }) {
  return (
    <div className="missions-steps">
      {steps.map(s => (
        <div key={s.stepId} className="missions-step">
          <span className={`dash-dot dash-dot--sm dash-dot--${stepDotStatus(s.status)}`} />
          <span className="missions-step-label">{s.title}</span>
          <span className="missions-step-role">{s.role}</span>
          {s.startedAt && (
            <span className="missions-step-time">
              {elapsed(s.startedAt, s.completedAt)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function RunStats({ run, steps }: { run: MissionRunSummary; steps: MissionStepRunSummary[] }) {
  const done = steps.filter(s => s.status === "completed" || s.status === "skipped").length;
  const failed = steps.filter(s => s.status === "failed").length;
  const total = steps.length;

  return (
    <div className="missions-run-stats">
      <span className="missions-stat">
        {done}/{total} steps
      </span>
      {failed > 0 && <span className="missions-stat missions-stat--error">{failed} failed</span>}
      <span className="missions-stat">{elapsed(run.startedAt, run.completedAt)}</span>
      {run.haltMessage && (
        <span className="missions-stat missions-stat--warn" title={run.haltMessage}>
          {run.haltKind === "WORKER_DIED" ? "worker died" : run.haltKind?.toLowerCase().replace(/_/g, " ") ?? "halted"}
        </span>
      )}
    </div>
  );
}

function MissionRow({
  mission,
  run,
  busy,
  expanded,
  onToggle,
  onStart,
  onPause,
  onResume,
}: {
  mission: MissionListItem;
  run: MissionRunSummary | undefined;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onStart: () => void;
  onPause: (runId: number) => void;
  onResume: (runId: number) => void;
}) {
  const [steps, setSteps] = useState<MissionStepRunSummary[]>([]);
  const dot = missionDotStatus(run);
  const isRunning = run?.status === "running" || run?.status === "pending";
  const isPaused = run?.status === "paused";
  const isError = run?.status === "error";
  const isResumable = isPaused || isError;
  const hasRun = !!run;

  useEffect(() => {
    if (!expanded || !run) { setSteps([]); return; }
    let active = true;
    const poll = async () => {
      try {
        const s = await modus.getMissionSteps(run.id);
        if (active) setSteps(s);
      } catch { /* silent */ }
    };
    poll();
    const interval = isRunning ? setInterval(poll, 3000) : undefined;
    return () => { active = false; if (interval) clearInterval(interval); };
  }, [expanded, run?.id, isRunning]);

  return (
    <div className={`missions-row-wrap${expanded ? " missions-row-wrap--expanded" : ""}`}>
      <div className="missions-row" onClick={hasRun ? onToggle : undefined} style={hasRun ? { cursor: "pointer" } : undefined}>
        <span className={`dash-dot dash-dot--${dot}`} />
        <div className="missions-row-info">
          <span className="missions-row-name">{mission.label || mission.name}</span>
          {mission.description && !expanded && (
            <span className="missions-row-desc">{mission.description}</span>
          )}
        </div>
        <div className="missions-row-meta">
          {run && <span className="missions-run-status">{run.status}</span>}
          {run?.startedAt && !isRunning && (
            <span className="missions-run-ago">{timeAgo(run.startedAt)}</span>
          )}
          {run?.startedAt && isRunning && (
            <span className="missions-run-ago">{elapsed(run.startedAt)}</span>
          )}
          {!run && mission.stepCount > 0 && (
            <span className="missions-run-ago">{mission.stepCount} steps</span>
          )}
        </div>
        <div className="missions-row-actions" onClick={e => e.stopPropagation()}>
          {busy ? (
            <span className="missions-btn-busy">...</span>
          ) : isRunning ? (
            <button className="missions-btn" onClick={() => onPause(run!.id)}>pause</button>
          ) : isResumable ? (
            <>
              <button className="missions-btn missions-btn--primary" onClick={() => onResume(run!.id)}>resume</button>
              <button className="missions-btn" onClick={onStart}>restart</button>
            </>
          ) : (
            <button
              className="missions-btn missions-btn--primary"
              onClick={onStart}
              disabled={!mission.enabled}
            >
              start
            </button>
          )}
        </div>
      </div>
      {expanded && run && (
        <div className="missions-detail">
          <RunStats run={run} steps={steps} />
          {steps.length > 0 && <StepTracker steps={steps} />}
        </div>
      )}
    </div>
  );
}

export function Missions() {
  const { activeUP, activeUserProfile } = useProfiles();
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [runs, setRuns] = useState<MissionRunSummary[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const cwd = activeUP?.projects?.[0] ?? "";

  useEffect(() => {
    if (!cwd) return;
    modus.listMissions(cwd).then(setMissions).catch(() => {});
  }, [cwd]);

  useEffect(() => {
    if (!cwd) return;
    let active = true;
    const poll = async () => {
      try {
        const r = await modus.listMissionRuns({ cwd });
        if (active) setRuns(r);
      } catch { /* silent */ }
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [cwd]);

  const refreshRuns = useCallback(async () => {
    if (!cwd) return;
    try { setRuns(await modus.listMissionRuns({ cwd })); } catch { /* silent */ }
  }, [cwd]);

  const withBusy = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(prev => new Set(prev).add(name));
    try { await fn(); await refreshRuns(); } catch { /* silent */ }
    finally { setBusy(prev => { const s = new Set(prev); s.delete(name); return s; }); }
  }, [refreshRuns]);

  const handleStart = useCallback((name: string) => {
    withBusy(name, () => modus.startMission({ missionName: name, cwd, userProfile: activeUserProfile ?? undefined }));
  }, [cwd, activeUserProfile, withBusy]);

  const handlePause = useCallback((name: string, runId: number) => {
    withBusy(name, () => modus.pauseMission(runId, "user paused"));
  }, [withBusy]);

  const handleResume = useCallback((name: string, runId: number) => {
    withBusy(name, () => modus.resumeMission(runId));
  }, [withBusy]);

  const toggleExpanded = useCallback((name: string) => {
    setExpanded(prev => {
      const s = new Set(prev);
      if (s.has(name)) s.delete(name); else s.add(name);
      return s;
    });
  }, []);

  if (!cwd || missions.length === 0) return null;

  const runningCount = runs.filter(r => r.status === "running" || r.status === "pending").length;
  const completedCount = runs.filter(r => r.status === "completed").length;
  const errorCount = runs.filter(r => r.status === "error").length;

  return (
    <div className="missions-panel">
      <div className="missions-header">
        <span className="missions-title">missions</span>
        <span className="missions-count">{missions.length}</span>
        {runningCount > 0 && (
          <span className="missions-active">
            <span className="dash-dot dash-dot--streaming" />
            {runningCount} active
          </span>
        )}
        {completedCount > 0 && (
          <span className="missions-header-stat missions-header-stat--done">{completedCount} done</span>
        )}
        {errorCount > 0 && (
          <span className="missions-header-stat missions-header-stat--error">{errorCount} err</span>
        )}
      </div>
      <div className="missions-list">
        {missions.map(m => {
          const run = getActiveRun(runs, m.name);
          return (
            <MissionRow
              key={m.name}
              mission={m}
              run={run}
              busy={busy.has(m.name)}
              expanded={expanded.has(m.name)}
              onToggle={() => toggleExpanded(m.name)}
              onStart={() => handleStart(m.name)}
              onPause={(id) => handlePause(m.name, id)}
              onResume={(id) => handleResume(m.name, id)}
            />
          );
        })}
      </div>
    </div>
  );
}
