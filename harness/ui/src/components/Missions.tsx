import { useState, useEffect, useCallback } from "react";
import { modus } from "../modusClient";
import type { MissionListItem, MissionRunSummary } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileProvider";

function missionDotStatus(run: MissionRunSummary | undefined): string {
  if (!run) return "idle";
  if (run.status === "running") return "streaming";
  if (run.status === "pending") return "running";
  if (run.status === "paused") return "draft";
  if (run.status === "completed") return "done";
  if (run.status === "error") return "error";
  return "idle";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getActiveRun(runs: MissionRunSummary[], name: string): MissionRunSummary | undefined {
  const mine = runs.filter(r => r.missionName === name);
  const live = mine.find(r => r.status === "running" || r.status === "pending" || r.status === "paused");
  if (live) return live;
  return mine.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function MissionRow({
  mission,
  run,
  busy,
  onStart,
  onPause,
  onResume,
}: {
  mission: MissionListItem;
  run: MissionRunSummary | undefined;
  busy: boolean;
  onStart: () => void;
  onPause: (runId: number) => void;
  onResume: (runId: number) => void;
}) {
  const dot = missionDotStatus(run);
  const isRunning = run?.status === "running" || run?.status === "pending";
  const isPaused = run?.status === "paused";

  return (
    <div className="missions-row">
      <span className={`dash-dot dash-dot--${dot}`} />
      <div className="missions-row-info">
        <span className="missions-row-name">{mission.label || mission.name}</span>
        {mission.description && (
          <span className="missions-row-desc">{mission.description}</span>
        )}
      </div>
      <div className="missions-row-meta">
        {run && <span className="missions-run-status">{run.status}</span>}
        {run?.startedAt && !isRunning && (
          <span className="missions-run-ago">{timeAgo(run.startedAt)}</span>
        )}
        {!run && mission.stepCount > 0 && (
          <span className="missions-run-ago">{mission.stepCount}s</span>
        )}
      </div>
      <div className="missions-row-actions">
        {busy ? (
          <span className="missions-btn-busy">...</span>
        ) : isRunning ? (
          <button className="missions-btn" onClick={() => onPause(run!.id)}>pause</button>
        ) : isPaused ? (
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
  );
}

export function Missions() {
  const { activeUP, activeUserProfile } = useProfiles();
  const [missions, setMissions] = useState<MissionListItem[]>([]);
  const [runs, setRuns] = useState<MissionRunSummary[]>([]);
  const [busy, setBusy] = useState<Set<string>>(new Set());
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

  if (!cwd || missions.length === 0) return null;

  const runningCount = runs.filter(r => r.status === "running" || r.status === "pending").length;

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
