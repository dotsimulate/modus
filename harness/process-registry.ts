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
import { spawnSync } from "node:child_process";

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
  /** OS PID when known (single — used by orphan rows) */
  osPid?: number;
  /** EVERY OS PID this session has spawned that is not yet confirmed dead.
   *  For sessions, this is the authoritative list of underlying child trees
   *  the harness has launched. The UI shows this and `killProcess` walks it. */
  osPids: number[];
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
      osPids: Array.from(session.osPids),
    });
  }

  for (const orphan of listOrphanClaudeProcesses()) {
    processes.push(orphan);
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
  if (sessionId.startsWith("os:")) {
    const pid = Number(sessionId.slice(3));
    if (!Number.isFinite(pid)) {
      return { ok: false, error: `Invalid OS process ID: ${sessionId}` };
    }
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Failed to kill ${sessionId}: ${err}` };
    }
  }

  const session = getActiveSession(sessionId);
  if (!session) {
    return { ok: false, error: `No active session: ${sessionId}` };
  }

  try {
    // 1. Provider abort: closes input channel, calls SDK query.close, and (for
    //    providers that implement it) walks its own osPids set with taskkill /T /F.
    session._provider.abort(session);
  } catch (err) {
    return { ok: false, error: `Failed to abort ${sessionId}: ${err}` };
  }
  // 2. Belt-and-braces: even if the provider's abort missed something, taskkill
  //    every PID this session has on record. SDK close() is unreliable on Windows
  //    (cmd.exe → claude → node tree survives on MCP HTTP keepalives), so the
  //    registry is the authoritative kill path.
  const survivors = Array.from(session.osPids);
  for (const pid of survivors) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch { /* ignore */ }
    session.osPids.delete(pid);
  }
  return { ok: true };
}

type OsProcessRow = {
  pid?: number;
  ppid?: number;
  name?: string;
  commandLine?: string;
};

function listOrphanClaudeProcesses(): ProcessInfo[] {
  if (process.platform !== "win32") return [];

  // Use wmic via cmd.exe instead of PowerShell — PowerShell depends on .NET
  // which can be broken by system crashes. wmic is a native Win32 binary.
  const currentPort = Number(process.env.HARNESS_PORT ?? 3777);
  const result = spawnSync(
    "cmd.exe",
    [
      "/c",
      "wmic process where \"name='node.exe'\" get ProcessId,ParentProcessId,CommandLine /format:csv",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5000 },
  );

  if (result.status !== 0 || !result.stdout?.trim()) return [];

  // Parse wmic CSV output: "Node,CommandLine,ParentProcessId,ProcessId\nHOST,cmd...,1234,5678"
  const lines = result.stdout.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const rows: OsProcessRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",");
    if (parts.length < 4) continue;
    // CSV: Node, CommandLine (may contain commas), ..., ParentProcessId, ProcessId
    // CommandLine can contain commas, so take last two fields as ppid/pid
    const pid = Number(parts[parts.length - 1]);
    const ppid = Number(parts[parts.length - 2]);
    const commandLine = parts.slice(1, parts.length - 2).join(",");
    if (!pid) continue;
    rows.push({ pid, ppid, name: "node.exe", commandLine });
  }
  const knownSessionIds = new Set(getAllActiveSessions().map((session) => session.sessionId));

  return rows
    .filter((row) => row.pid && row.commandLine)
    .filter((row) => {
      const commandLine = row.commandLine ?? "";
      // Either it's a Claude Code SDK CLI process, OR its command line shows
      // it's connected to the Modus MCP endpoint on this harness's port.
      // No binary-name-only matches — those caused false positives before.
      if (commandLine.includes("@anthropic-ai/claude-code/cli.js")
        || commandLine.includes("@anthropic-ai\\claude-code\\cli.js")) return true;
      if (commandLine.includes(`127.0.0.1:${currentPort}/api/mcp/modus`)) return true;
      return false;
    })
    .filter((row) => !Array.from(knownSessionIds).some((sessionId) => (row.commandLine ?? "").includes(sessionId)))
    .map((row) => ({
      id: `os:${row.pid}`,
      kind: "session" as const,
      status: "orphaned",
      profile: null,
      provider: "claude-code",
      model: null,
      costUsd: 0,
      numTurns: 0,
      startedAt: 0,
      lastEventAt: 0,
      preview: (row.commandLine ?? "").slice(0, 160),
      cwd: null,
      mission: null,
      activeMoves: [],
      subscribers: 0,
      canKill: true,
      osPid: row.pid,
      osPids: row.pid ? [row.pid] : [],
    }))
    // Drop the harness's own bun process and the harness itself if they slipped in.
    .filter((p) => p.osPid !== process.pid && p.osPid !== process.ppid);
}
