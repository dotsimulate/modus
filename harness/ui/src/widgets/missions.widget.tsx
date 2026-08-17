/**
 * Missions widget — mission-centric sidebar + inline detail.
 *
 * Lists mission definitions; each row expands inline to show the active (or
 * last) run's steps, gates, transfers, and spawned sessions.
 *
 * pageContext:
 *   publish → missionRunId; select-session intents update sessionId
 *   subscribe ← (none — self-manages selection)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { sessionActivityAt as activityAt } from "../sessionActivity";
import type {
  MissionListItem,
  MissionRunSummary,
  MissionStepRunSummary,
  MissionTransferSummary,
  MissionGateResultSummary,
  SessionInfo,
} from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

type MissionsConfig = WidgetBase & {
  type: "missions";
};

type DetailTab = "steps" | "gates" | "transfers" | "sessions";

// ── Helpers ──

function runDot(run: MissionRunSummary | undefined): string {
  if (!run) return "idle";
  if (run.status === "running") return "streaming";
  if (run.status === "pending") return "running";
  if (run.status === "paused") return "draft";
  if (run.status === "completed") return "done";
  if (run.status === "error") return "error";
  return "idle";
}

function stepDot(status: string): string {
  if (status === "running") return "streaming";
  if (status === "completed" || status === "skipped") return "done";
  if (status === "failed") return "error";
  return "idle";
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function elapsed(start: number, end?: number | null): string {
  const ms = (end ?? Date.now()) - start;
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h${Math.floor((ms % 3600000) / 60000)}m`;
}

function activeRunFor(runs: MissionRunSummary[], name: string): MissionRunSummary | undefined {
  const mine = runs.filter(r => r.missionName === name);
  const live = mine.find(r => r.status === "running" || r.status === "pending" || r.status === "paused");
  if (live) return live;
  return mine.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

// ── Detail panel ──

function MissionDetail({
  runId,
  onSelectSession,
}: {
  runId: number;
  onSelectSession: (id: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("steps");

  const loadSteps = useCallback(() => modus.getMissionSteps(runId), [runId]);
  const loadGates = useCallback(() => modus.getMissionGates(runId), [runId]);
  const loadTransfers = useCallback(() => modus.getMissionTransfers(runId), [runId]);
  const loadSessionIds = useCallback(() => modus.getMissionSessions(runId), [runId]);

  const { value: steps } = useWidgetPollingValue<MissionStepRunSummary[]>({
    load: loadSteps, scopeKey: `missions-steps:${runId}`, intervalMs: 3000, initialValue: [],
  });
  const { value: gates } = useWidgetPollingValue<MissionGateResultSummary[]>({
    load: loadGates, scopeKey: `missions-gates:${runId}`, intervalMs: 5000, initialValue: [],
  });
  const { value: transfers } = useWidgetPollingValue<MissionTransferSummary[]>({
    load: loadTransfers, scopeKey: `missions-transfers:${runId}`, intervalMs: 4000, initialValue: [],
  });
  const { value: sessionIds } = useWidgetPollingValue<string[]>({
    load: loadSessionIds, scopeKey: `missions-sessions:${runId}`, intervalMs: 5000, initialValue: [],
  });

  const loadSessionInfos = useCallback(async () => {
    if (sessionIds.length === 0) return [];
    const all = await modus.listSessions({ limit: 500 });
    const idSet = new Set(sessionIds);
    return all.filter(s => idSet.has(s.id));
  }, [sessionIds]);
  const { value: sessions } = useWidgetPollingValue<SessionInfo[]>({
    load: loadSessionInfos,
    scopeKey: `missions-session-infos:${runId}:${sessionIds.join(",")}`,
    intervalMs: 5000,
    initialValue: [],
  });

  const tabs: { key: DetailTab; label: string; count: number }[] = [
    { key: "steps", label: "steps", count: steps.length },
    { key: "gates", label: "gates", count: gates.length },
    { key: "transfers", label: "transfers", count: transfers.length },
    { key: "sessions", label: "sessions", count: sessions.length },
  ];

  return (
    <div className="mission-detail">
      <div className="mission-detail-tabs">
        {tabs.map(t => (
          <button
            key={t.key}
            className={`mission-detail-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {t.count > 0 && <span className="mission-detail-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="mission-detail-body">
        {tab === "steps" && <StepsPanel steps={steps} />}
        {tab === "gates" && <GatesPanel gates={gates} />}
        {tab === "transfers" && (
          <TransfersPanel transfers={transfers} onSelectSession={onSelectSession} />
        )}
        {tab === "sessions" && (
          <SessionsPanel sessions={sessions} onSelectSession={onSelectSession} />
        )}
      </div>
    </div>
  );
}

function StepsPanel({ steps }: { steps: MissionStepRunSummary[] }) {
  if (steps.length === 0) return <div className="mission-detail-empty">no steps yet</div>;
  return (
    <div className="mission-steps-list">
      {steps.map(s => (
        <div key={s.stepId} className="mission-step-row">
          <span className={`dash-dot dash-dot--sm dash-dot--${stepDot(s.status)}`} />
          <span className="mission-step-title">{s.title}</span>
          <span className="mission-step-role">{s.role}</span>
          <span className="mission-step-status">{s.status}</span>
          {s.startedAt && (
            <span className="mission-step-time">{elapsed(s.startedAt, s.completedAt)}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function GatesPanel({ gates }: { gates: MissionGateResultSummary[] }) {
  if (gates.length === 0) return <div className="mission-detail-empty">no gates recorded</div>;
  return (
    <div className="mission-gates-list">
      {gates.map(g => (
        <div key={g.id} className="mission-gate-row">
          <span className={`mission-gate-badge mission-gate-badge--${g.status}`}>{g.status}</span>
          <span className="mission-gate-type">{g.gateType}</span>
          <span className="mission-gate-step">{g.stepId}</span>
          {g.evidence && <span className="mission-gate-evidence" title={g.evidence}>{g.evidence}</span>}
          <span className="mission-gate-time">{timeAgo(g.checkedAt)}</span>
        </div>
      ))}
    </div>
  );
}

function TransfersPanel({
  transfers,
  onSelectSession,
}: {
  transfers: MissionTransferSummary[];
  onSelectSession: (id: string) => void;
}) {
  if (transfers.length === 0) return <div className="mission-detail-empty">no transfers yet</div>;
  const sorted = [...transfers].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div className="mission-transfers-list">
      {sorted.map(t => (
        <div key={t.id} className="mission-transfer-row">
          <span className={`mission-transfer-kind mission-transfer-kind--${t.kind}`}>{t.kind}</span>
          <span className="mission-transfer-step">{t.stepId}</span>
          <span className="mission-transfer-path">
            {t.fromSessionId ? (
              <button
                className="mission-sid-btn"
                onClick={() => onSelectSession(t.fromSessionId!)}
                title={t.fromSessionId}
              >{t.fromSessionId.slice(0, 8)}</button>
            ) : <span className="mission-sid-empty">—</span>}
            <span className="mission-transfer-arrow">→</span>
            {t.toSessionId ? (
              <button
                className="mission-sid-btn"
                onClick={() => onSelectSession(t.toSessionId!)}
                title={t.toSessionId}
              >{t.toSessionId.slice(0, 8)}</button>
            ) : <span className="mission-sid-empty">—</span>}
          </span>
          {t.summary && <span className="mission-transfer-summary" title={t.summary}>{t.summary}</span>}
          <span className="mission-transfer-time">{timeAgo(t.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function SessionsPanel({
  sessions,
  onSelectSession,
}: {
  sessions: SessionInfo[];
  onSelectSession: (id: string) => void;
}) {
  if (sessions.length === 0) return <div className="mission-detail-empty">no sessions spawned</div>;
  const sorted = [...sessions].sort((a, b) => activityAt(b) - activityAt(a));
  return (
    <div className="mission-sessions-list">
      {sorted.map(s => (
        <button
          key={s.id}
          className="mission-session-row"
          onClick={() => onSelectSession(s.id)}
          title={s.id}
        >
          <span className={`dash-dot dash-dot--sm dash-dot--${stepDot(s.status)}`} />
          <span className="mission-session-title">
            {s.title || s.last_prompt || s.preview || s.id.slice(0, 8)}
          </span>
          {s.profile && <span className="mission-session-profile">{s.profile}</span>}
          <span className="mission-session-msgs">{s.message_count}m</span>
          <span className="mission-session-time">{timeAgo(activityAt(s))}</span>
        </button>
      ))}
    </div>
  );
}

// ── Main widget ──

export default function MissionsWidget({ pageContext, onSelectSession }: WidgetProps<MissionsConfig>) {
  const { activeUP, activeUserProfile } = useProfiles();
  const cwd = activeUP?.projects?.[0] ?? "";

  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const loadMissions = useCallback(
    () => (cwd ? modus.listMissions(cwd) : Promise.resolve([])),
    [cwd],
  );
  const loadRuns = useCallback(
    () => (cwd ? modus.listMissionRuns({ cwd }) : Promise.resolve([])),
    [cwd],
  );

  const { value: missions } = useWidgetPollingValue<MissionListItem[]>({
    load: loadMissions, scopeKey: `missions-list:${cwd}`, intervalMs: 10000, initialValue: [],
  });
  const { value: runs, refresh: refreshRuns } = useWidgetPollingValue<MissionRunSummary[]>({
    load: loadRuns, scopeKey: `missions-runs:${cwd}`, intervalMs: 3000, initialValue: [],
  });

  const activeByName = useMemo(() => {
    const m = new Map<string, MissionRunSummary | undefined>();
    for (const mission of missions) m.set(mission.name, activeRunFor(runs, mission.name));
    return m;
  }, [missions, runs]);

  const selectedRun = selectedName ? activeByName.get(selectedName) : undefined;

  // Publish missionRunId whenever selection changes
  useEffect(() => {
    pageContext?.set("missionRunId", selectedRun?.id ?? null);
  }, [selectedRun?.id, pageContext]);

  const handleSelectSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  const withBusy = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(prev => new Set(prev).add(name));
    try { await fn(); await refreshRuns(); } catch { /* silent */ }
    finally { setBusy(prev => { const s = new Set(prev); s.delete(name); return s; }); }
  }, [refreshRuns]);

  const handleStart = useCallback((name: string) => {
    withBusy(name, () => modus.startMission({ missionName: name, cwd, userProfile: activeUserProfile ?? undefined }));
  }, [cwd, activeUserProfile, withBusy]);

  const handlePause = useCallback((name: string, id: number) => {
    withBusy(name, () => modus.pauseMission(id, "user paused"));
  }, [withBusy]);

  const handleResume = useCallback((name: string, id: number) => {
    withBusy(name, () => modus.resumeMission(id));
  }, [withBusy]);

  if (!cwd) return <WidgetEmptyState>no project selected</WidgetEmptyState>;
  if (missions.length === 0) return <WidgetEmptyState>no missions in this project</WidgetEmptyState>;

  return (
    <div className="missions-widget">
      <div className="missions-widget-list">
        {missions.map(m => {
          const run = activeByName.get(m.name);
          const isSelected = selectedName === m.name;
          const isBusy = busy.has(m.name);
          const isRunning = run?.status === "running" || run?.status === "pending";
          const isResumable = run?.status === "paused" || run?.status === "error";

          return (
            <div
              key={m.name}
              className={`missions-widget-row-wrap${isSelected ? " selected" : ""}`}
            >
              <div
                className="missions-widget-row"
                onClick={() => setSelectedName(isSelected ? null : m.name)}
              >
                <span className={`dash-dot dash-dot--${runDot(run)}`} />
                <div className="missions-widget-row-info">
                  <span className="missions-widget-row-name">{m.label || m.name}</span>
                  {m.description && !isSelected && (
                    <span className="missions-widget-row-desc">{m.description}</span>
                  )}
                </div>
                <div className="missions-widget-row-meta">
                  {run && <span className="missions-widget-run-status">{run.status}</span>}
                  {run?.startedAt && (
                    <span className="missions-widget-run-ago">
                      {isRunning ? elapsed(run.startedAt) : timeAgo(run.startedAt)}
                    </span>
                  )}
                  {!run && <span className="missions-widget-run-ago">{m.stepCount} steps</span>}
                </div>
                <div className="missions-widget-row-actions" onClick={e => e.stopPropagation()}>
                  {isBusy ? (
                    <span className="missions-btn-busy">...</span>
                  ) : isRunning ? (
                    <button className="missions-btn" onClick={() => handlePause(m.name, run!.id)}>pause</button>
                  ) : isResumable ? (
                    <>
                      <button className="missions-btn missions-btn--primary" onClick={() => handleResume(m.name, run!.id)}>resume</button>
                      <button className="missions-btn" onClick={() => handleStart(m.name)}>restart</button>
                    </>
                  ) : (
                    <button
                      className="missions-btn missions-btn--primary"
                      onClick={() => handleStart(m.name)}
                      disabled={!m.enabled}
                    >start</button>
                  )}
                </div>
              </div>
              {isSelected && run && (
                <MissionDetail runId={run.id} onSelectSession={handleSelectSession} />
              )}
              {isSelected && !run && (
                <div className="mission-detail-empty">
                  no run yet — press start to spawn the orchestrator
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
