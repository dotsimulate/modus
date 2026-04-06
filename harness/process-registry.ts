/**
 * Process Registry — unified view of everything the harness is running.
 *
 * This is NOT a new data store. It assembles a snapshot from existing subsystems:
 *   - session-manager:  activeSessions map (live agent sessions)
 *   - mission-runner:   orchestratorSessions + grantStore (mission context)
 *   - move-runner:      active move tokens per session
 *   - terminal-manager: managed terminals/shells
 *
 * Every entry includes a kill path. No more ghost processes.
 */

import { getAllActiveSessions, getActiveSession, type ActiveSession } from "./session-manager";
import {
  getActiveMissionGrants,
  getActiveOrchestratorRunIds,
  listMissionRunSummaries,
} from "./mission-runner";
import { getActiveTokensForSession } from "./move-runner";

// ── Types ──

export type ProcessKind =
  | "orchestrator"   // mission orchestrator session
  | "worker"         // mission worker session
  | "session"        // standalone session (no mission)
  | "terminal";      // managed terminal/shell

export type ProcessInfo = {
  /** Session ID (or terminal ID for terminals) */
  id: string;
  kind: ProcessKind;
  status: string;
  profile: string | null;
  provider: string;
  model: string | null;
  costUsd: number;
  numTurns: number;
  startedAt: number;
  lastEventAt: number;
  preview: string;
  cwd: string | null;

  /** Mission context — only present for orchestrator/worker kinds */
  mission: {
    runId: number;
    missionName: string;
    role: string;
    currentCycle: number;
    runStatus: string;
  } | null;

  /** Active move bindings on this session */
  activeMoves: string[];

  /** Number of SSE subscribers watching this session */
  subscribers: number;

  /** Whether this process can be killed from the UI */
  canKill: boolean;
};

export type ProcessSnapshot = {
  timestamp: number;
  processes: ProcessInfo[];
  summary: {
    total: number;
    byKind: Record<string, number>;
    totalCostUsd: number;
    missionRuns: number;
  };
};

// ── Snapshot Assembly ──

/**
 * Build a unified snapshot of every managed process in the harness.
 * Cheap to call — just iterates in-memory maps, no DB queries except
 * for mission run metadata (already cached per-run).
 */
export function getProcessSnapshot(): ProcessSnapshot {
  const activeSessions = getAllActiveSessions();
  const orchestratorRunIds = getActiveOrchestratorRunIds();
  const missionGrants = getActiveMissionGrants();
  const runSummaryCache = new Map<number, { missionName: string; currentCycle: number; status: string }>();

  // Build session→mission mapping from grants
  const sessionMissionMap = new Map<string, { runId: number; role: string }>();
  for (const grant of missionGrants) {
    if (grant.sessionId) {
      sessionMissionMap.set(grant.sessionId, { runId: grant.runId, role: grant.role });
    }
  }

  // Also map orchestrator sessions
  for (const [runId, sessionId] of orchestratorRunIds) {
    if (!sessionMissionMap.has(sessionId)) {
      sessionMissionMap.set(sessionId, { runId, role: "orchestrator" });
    }
  }

  const processes: ProcessInfo[] = [];

  for (const session of activeSessions) {
    const missionCtx = sessionMissionMap.get(session.sessionId);
    let mission: ProcessInfo["mission"] = null;

    if (missionCtx) {
      // Resolve mission run metadata (cache to avoid repeated queries)
      let cached = runSummaryCache.get(missionCtx.runId);
      if (!cached) {
        const summaries = listMissionRunSummaries();
        for (const s of summaries) {
          runSummaryCache.set(s.id, {
            missionName: s.missionName,
            currentCycle: s.currentCycle ?? 1,
            status: s.status,
          });
        }
        cached = runSummaryCache.get(missionCtx.runId);
      }
      if (cached) {
        mission = {
          runId: missionCtx.runId,
          missionName: cached.missionName,
          role: missionCtx.role,
          currentCycle: cached.currentCycle,
          runStatus: cached.status,
        };
      }
    }

    // Determine kind
    let kind: ProcessKind = "session";
    if (mission) {
      kind = mission.role === "orchestrator" ? "orchestrator" : "worker";
    }

    // Get active moves
    const moveTokens = getActiveTokensForSession(session.sessionId);
    const activeMoves = moveTokens.map((t) => t.moveName);

    processes.push({
      id: session.sessionId,
      kind,
      status: session.status,
      profile: session.profile ?? null,
      provider: session.provider,
      model: session.model ?? null,
      costUsd: session.costUsd,
      numTurns: session.numTurns,
      startedAt: session.startedAt,
      lastEventAt: session.lastEventAt,
      preview: session.preview,
      cwd: session.cwd ?? null,
      mission,
      activeMoves,
      subscribers: session.subscribers.size,
      canKill: true,
    });
  }

  // Sort: orchestrators first, then workers, then sessions. Within each, newest first.
  const kindOrder: Record<ProcessKind, number> = { orchestrator: 0, worker: 1, session: 2, terminal: 3 };
  processes.sort((a, b) => {
    const ko = (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
    if (ko !== 0) return ko;
    return b.startedAt - a.startedAt;
  });

  // Summary
  const byKind: Record<string, number> = {};
  let totalCostUsd = 0;
  const missionRunIds = new Set<number>();
  for (const p of processes) {
    byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
    totalCostUsd += p.costUsd;
    if (p.mission) missionRunIds.add(p.mission.runId);
  }

  return {
    timestamp: Date.now(),
    processes,
    summary: {
      total: processes.length,
      byKind,
      totalCostUsd,
      missionRuns: missionRunIds.size,
    },
  };
}

/**
 * Kill a managed process by session ID.
 * Aborts the session's provider, which tears down the SDK subprocess and MCP transports.
 */
export function killProcess(sessionId: string): { ok: boolean; error?: string } {
  const session = getActiveSession(sessionId);
  if (!session) {
    return { ok: false, error: `No active session: ${sessionId}` };
  }

  try {
    // AbortController.abort() triggers the provider's cleanup path,
    // which calls queryObj.close() — killing the CLI subprocess and MCP transports.
    session.abortController.abort();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to kill ${sessionId}: ${err}` };
  }
}
