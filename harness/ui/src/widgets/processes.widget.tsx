import { useCallback, useEffect, useState } from "react";
import type { ProcessInfo, ProcessSnapshot } from "../../../sdk/index";
import { modus } from "../modusClient";
import { useSession } from "../providers/SessionProvider";
import { useWidgetChrome, type WidgetBase, type WidgetDef, type WidgetProps } from "./index";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

type ProcessesConfig = WidgetBase & {
  type: "processes";
  /** Show only mission-related processes */
  missionsOnly?: boolean;
};

function kindLabel(kind: string): string {
  if (kind === "orchestrator") return "orch";
  if (kind === "worker") return "wkr";
  if (kind === "terminal") return "term";
  return "ses";
}

function kindClass(kind: string): string {
  return `proc-kind--${kind}`;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}\u2026${id.slice(-4)}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<1\u00a2";
  return `$${usd.toFixed(2)}`;
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

function ProcessesWidget({ config, onSelectSession }: WidgetProps<ProcessesConfig>) {
  const { activeSession } = useSession();
  const { setHeaderSuffix } = useWidgetChrome();
  const [killingId, setKillingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const snapshot = await modus.listProcesses();
    if (config.missionsOnly) {
      return {
        ...snapshot,
        processes: snapshot.processes.filter((p: ProcessInfo) => p.mission !== null),
      };
    }
    return snapshot;
  }, [config.missionsOnly]);

  const { value, loading, refresh } = useWidgetPollingValue<ProcessSnapshot>({
    load,
    scopeKey: `processes:${config.missionsOnly ? "missions" : "all"}`,
    intervalMs: 3000,
    initialValue: { timestamp: 0, processes: [], summary: { total: 0, byKind: {}, totalCostUsd: 0, missionRuns: 0 } },
  });

  useEffect(() => {
    if (!loading) {
      const n = value.processes.length;
      const cost = value.summary.totalCostUsd;
      setHeaderSuffix(`(${n}${cost > 0.01 ? ` \u00b7 ${formatCost(cost)}` : ""})`);
    }
  }, [loading, setHeaderSuffix, value]);

  useEffect(() => {
    return () => { setHeaderSuffix(null); };
  }, [setHeaderSuffix]);

  const handleKill = useCallback(async (id: string) => {
    setKillingId(id);
    try {
      await modus.killProcess(id);
      await refresh();
    } catch (err) {
      console.error("[processes.widget] failed to kill", id, err);
    } finally {
      setKillingId((c) => (c === id ? null : c));
    }
  }, [refresh]);

  if (loading) return <WidgetEmptyState>loading processes...</WidgetEmptyState>;
  if (value.processes.length === 0) return <WidgetEmptyState>no active processes</WidgetEmptyState>;

  return (
    <div className="proc-widget">
      {value.summary.missionRuns > 0 && (
        <div className="proc-summary">
          {value.summary.missionRuns} mission{value.summary.missionRuns > 1 ? "s" : ""} {"\u00b7"}{" "}
          {value.summary.total} process{value.summary.total > 1 ? "es" : ""} {"\u00b7"}{" "}
          {formatCost(value.summary.totalCostUsd)}
        </div>
      )}
      {value.processes.map((proc: ProcessInfo) => {
        const isMe = proc.id === activeSession?.id;
        return (
          <div key={proc.id} className={`proc-row ${isMe ? "proc-row--me" : ""}`}>
            <div className="proc-row-main">
              <div className="proc-row-top">
                <span className={`proc-kind ${kindClass(proc.kind)}`}>{kindLabel(proc.kind)}</span>
                <span className={`proc-status proc-status--${proc.status}`}>{proc.status}</span>
                {proc.profile && <span className="proc-profile">{proc.profile}</span>}
              </div>
              {proc.model && <div className="proc-model" title={proc.model}>{proc.model}</div>}
              {proc.mission && (
                <div className="proc-mission">
                  <span className="proc-mission-name">{proc.mission.missionName}</span>
                  <span className="proc-mission-role">{proc.mission.role}</span>
                  <span className="proc-mission-cycle">cycle {proc.mission.currentCycle}</span>
                </div>
              )}
              <div className="proc-row-meta">
                <span title={proc.id}>{shortId(proc.id)}</span>
                <span>{proc.numTurns} turns</span>
                <span>{formatCost(proc.costUsd)}</span>
                <span>started {timeAgo(proc.startedAt)}</span>
                {proc.lastEventAt > proc.startedAt && <span>active {timeAgo(proc.lastEventAt)}</span>}
              </div>
              {proc.activeMoves.length > 0 && (
                <div className="proc-moves">
                  moves: {proc.activeMoves.join(", ")}
                </div>
              )}
              {proc.preview && (
                <div className="proc-preview">{proc.preview.slice(0, 100)}</div>
              )}
            </div>
            <div className="proc-actions">
              {!isMe && (
                <button
                  className="proc-jump"
                  onClick={() => onSelectSession(proc.id)}
                  title="Open session"
                >
                  open
                </button>
              )}
              {proc.canKill && !isMe && (
                <button
                  className="proc-kill"
                  onClick={() => { void handleKill(proc.id); }}
                  disabled={killingId === proc.id}
                  title="Kill this process (aborts provider, tears down subprocess)"
                >
                  {killingId === proc.id ? "killing" : "kill"}
                </button>
              )}
              {isMe && <span className="proc-me">this session</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const def: WidgetDef = { type: "processes", component: ProcessesWidget };
export default def;
