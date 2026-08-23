/**
 * Action Card widget — single action status and trigger.
 *
 * Config: { "type": "action-card", "id": "heartbeat-card", "actionName": "heartbeat" }
 *
 * Shows one action's status, last run info, and a trigger button.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import type { ActionInfo, ActionRun } from "../../../sdk/index";
import { describeActionCycleLimit, describeActionRunLimit } from "../action-limit-display";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type ActionCardConfig = WidgetBase & {
  type: "action-card";
  actionName?: string;
};

function timeAgo(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "unknown";
  const diff = Date.now() - ts;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatUsd(value: unknown, digits = 3): string {
  return `$${finiteNumber(value).toFixed(digits)}`;
}

function dotClass(a: ActionInfo): string {
  if (a.running) return "streaming";
  if (a.exhausted) return "done";
  if (!a.enabled) return "idle";
  if (a.lastStatus === "error" || a.lastStatus === "failed-verification") return "error";
  return "running";
}

export default function ActionCardWidget({ config }: WidgetProps<ActionCardConfig>) {
  const { activeUserProfile, activeCwd } = useProfiles();
  const [action, setAction] = useState<ActionInfo | null>(null);
  const [lastRun, setLastRun] = useState<ActionRun | null>(null);
  const [, setTick] = useState(0);

  const actionName = config.actionName;
  const actionScope = useMemo(
    () => ({ userProfile: activeUserProfile, cwd: activeCwd }),
    [activeUserProfile, activeCwd],
  );

  // Poll for action state
  useEffect(() => {
    if (!actionName) return;
    let active = true;

    const poll = async () => {
      try {
        const actions = await modus.listActions(actionScope);
        const found = actions.find((a) => a.name === actionName);
        if (active && found) setAction(found);
      } catch { /* silent */ }

      try {
        const runs = await modus.getActionRuns(actionName, undefined, actionScope);
        if (active && runs.length > 0) setLastRun(runs[0]);
      } catch { /* silent */ }
    };

    poll();
    const interval = setInterval(poll, 3000);
    const tickInterval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => { active = false; clearInterval(interval); clearInterval(tickInterval); };
  }, [actionName, actionScope]);

  const handleTrigger = useCallback(async () => {
    if (!actionName) return;
    await modus.triggerAction(actionName, actionScope).catch(() => {});
  }, [actionName, actionScope]);

  const handleToggle = useCallback(async (enabled: boolean) => {
    if (!actionName) return;
    await modus.patchAction(actionName, { enabled }, actionScope).catch(() => {});
    setAction((prev) => prev ? { ...prev, enabled } : prev);
  }, [actionName, actionScope]);

  if (!actionName) {
    return <WidgetEmptyState>no action configured</WidgetEmptyState>;
  }

  if (!action) {
    return <WidgetEmptyState>loading {actionName}...</WidgetEmptyState>;
  }

  const dot = dotClass(action);
  const runCount = finiteNumber(action.cycleRunCount);
  const cycleNumber = finiteNumber(action.cycleNumber, 1);
  const hasCycles = !!action.cycleInterval;
  const runLimit = describeActionRunLimit(runCount, action.maxRuns, hasCycles);
  const cycleLimit = describeActionCycleLimit(cycleNumber, action.maxCycles);
  const activeSessions = finiteNumber(action.activeSessions);
  const concurrency = Math.max(1, finiteNumber(action.concurrency, 1));

  return (
    <div className="action-card-widget">
      <div className="action-card-header">
        <span className={`dash-dot dash-dot--${dot}`} />
        <span className="action-card-name">{action.name}</span>
        {action.running && <span className="action-card-live">running</span>}
        {action.exhausted && !action.running && <span className="action-card-done">complete</span>}
      </div>

      {action.description && (
        <div className="action-card-desc">{action.description}</div>
      )}

      <div className="action-card-meta">
        <span className="action-card-tag">{action.agentProfile}</span>
        <span className="action-card-stat">{runLimit.label}</span>
        {hasCycles && <span className="action-card-stat">{cycleLimit.label}</span>}
      </div>

      {lastRun && (
        <div className="action-card-lastrun">
          <span className={`dash-dot dash-dot--${lastRun.status === "done" ? "done" : lastRun.status === "error" ? "error" : "idle"}`} />
          <span className="action-card-lastrun-summary">
            {lastRun.summary || lastRun.status}
          </span>
          {lastRun.startedAt && (
            <span className="action-card-lastrun-ago">{timeAgo(finiteNumber(lastRun.startedAt))}</span>
          )}
          {finiteNumber(lastRun.costUsd) > 0 && (
            <span className="action-card-lastrun-cost">{formatUsd(lastRun.costUsd)}</span>
          )}
        </div>
      )}

      <div className="action-card-controls">
        <button
          className={`action-card-toggle ${action.enabled ? "action-card-toggle--on" : ""}`}
          onClick={() => handleToggle(!action.enabled)}
        >
          {action.enabled ? "enabled" : "disabled"}
        </button>
        <button
          className="action-card-trigger"
          onClick={handleTrigger}
          disabled={activeSessions >= concurrency}
        >
          run
        </button>
      </div>
    </div>
  );
}
