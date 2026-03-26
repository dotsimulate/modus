/**
 * SessionWebEdges — builds all graph edges from raw data.
 * No layout, no React. Pure edge construction.
 */

import type { SessionInfo, GitCommit, MissionTransferSummary, TouchRecord } from "../../../sdk/index";
import type { GraphEdge, MoveRun, HandoffDoc } from "./SessionWebLayout";
import { shortHash, parseTags } from "./SessionWebLayout";

export type EdgeBuildResult = {
  edges: GraphEdge[];
  handoffDocs: HandoffDoc[];
  /** hash7 -> session IDs that produced that commit */
  commitSessionMap: Map<string, string[]>;
  /** parent session -> child session IDs (handoff/delegation structural) */
  childrenOf: Map<string, string[]>;
  /** sessions that were spawned by another */
  spawnedSet: Set<string>;
};

export function buildAllEdges(
  sessions: SessionInfo[],
  moveRuns: MoveRun[],
  commits: GitCommit[],
  missionTransfers: MissionTransferSummary[],
  touches: TouchRecord[],
): EdgeBuildResult {
  const edges: GraphEdge[] = [];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  const sessionIds = new Set(sessions.map(s => s.id));

  // ── Handoff edges ──
  const handoffMoveRuns = moveRuns.filter(
    r => r.spawnedSessionId && sessionMap.has(r.sessionId) && sessionMap.has(r.spawnedSessionId!),
  );

  const handoffDocs: HandoffDoc[] = [];
  const lineageEdges: GraphEdge[] = [];

  for (const r of handoffMoveRuns) {
    let docPath: string | null = null;
    if (r.gatheredContext) {
      try {
        const gc = JSON.parse(r.gatheredContext);
        if (gc.handoffsDir && gc.handoffFilename) {
          docPath = `${gc.handoffsDir}/${gc.handoffFilename}`;
        }
      } catch { /* ignore */ }
    }

    if (docPath) {
      const docId = `doc:${r.id}`;
      const filename = docPath.split("/").pop() || docPath;
      handoffDocs.push({
        path: docPath,
        filename,
        moveRunId: r.id,
        fromSessionId: r.sessionId,
        toSessionId: r.spawnedSessionId!,
      });
      edges.push({ from: r.sessionId, to: docId, type: "document", moveName: r.moveName });
      edges.push({ from: docId, to: r.spawnedSessionId!, type: "handoff", moveName: r.moveName });
      lineageEdges.push({ from: r.sessionId, to: r.spawnedSessionId!, type: "handoff", moveName: r.moveName });
    } else {
      const e: GraphEdge = { from: r.sessionId, to: r.spawnedSessionId!, type: "handoff", moveName: r.moveName };
      edges.push(e);
      lineageEdges.push(e);
    }
  }

  // ── Mission delegation edges ──
  const missionStructuralKinds = new Set<MissionTransferSummary["kind"]>(["delegation", "review", "escalation"]);
  const delegationEdgeGroups = new Map<string, MissionTransferSummary[]>();
  for (const transfer of missionTransfers) {
    if (!transfer.fromSessionId || !transfer.toSessionId) continue;
    if (!sessionMap.has(transfer.fromSessionId) || !sessionMap.has(transfer.toSessionId)) continue;
    const key = `${transfer.fromSessionId}->${transfer.toSessionId}`;
    const grouped = delegationEdgeGroups.get(key) || [];
    grouped.push(transfer);
    delegationEdgeGroups.set(key, grouped);
  }
  for (const [key, grouped] of delegationEdgeGroups) {
    const [from, to] = key.split("->");
    grouped
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((transfer, index) => {
        edges.push({ from, to, type: "delegation", lane: index, kind: transfer.kind });
      });
  }

  // ── Commit edges ──
  const commitSessionMap = new Map<string, string[]>();
  for (const s of sessions) {
    const tags = parseTags(s.tags);
    for (const t of tags) {
      if (t.startsWith("commit:")) {
        const hash = t.slice(7);
        const arr = commitSessionMap.get(hash) || [];
        arr.push(s.id);
        commitSessionMap.set(hash, arr);
      }
    }
  }
  const linkedCommits = commits.filter(
    c => commitSessionMap.has(shortHash(c.hash)) || commitSessionMap.has(c.hash),
  );
  for (const c of linkedCommits) {
    const h7 = shortHash(c.hash);
    const linked = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    for (const sid of linked) {
      edges.push({ from: sid, to: `commit:${h7}`, type: "commit" });
    }
  }

  // ── Touch (co-edit / co-read) edges ──
  const fileMap = new Map<string, { sessionId: string; op: string }[]>();
  for (const t of touches) {
    if (!sessionIds.has(t.sessionId)) continue;
    const arr = fileMap.get(t.filePath) || [];
    arr.push({ sessionId: t.sessionId, op: t.op });
    fileMap.set(t.filePath, arr);
  }

  const edgeCounts = new Map<string, { coEdit: number; coRead: number }>();
  for (const [, entries] of fileMap) {
    const sessionsForFile = new Map<string, Set<string>>();
    for (const e of entries) {
      const ops = sessionsForFile.get(e.sessionId) || new Set();
      ops.add(e.op);
      sessionsForFile.set(e.sessionId, ops);
    }
    const sids = [...sessionsForFile.keys()];
    if (sids.length < 2) continue;
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        const a = sids[i], b = sids[j];
        const key = a < b ? `${a}->${b}` : `${b}->${a}`;
        const aOps = sessionsForFile.get(a)!;
        const bOps = sessionsForFile.get(b)!;
        const aWrites = aOps.has("write") || aOps.has("edit");
        const bWrites = bOps.has("write") || bOps.has("edit");
        const counts = edgeCounts.get(key) || { coEdit: 0, coRead: 0 };
        if (aWrites && bWrites) counts.coEdit++;
        else counts.coRead++;
        edgeCounts.set(key, counts);
      }
    }
  }
  for (const [key, counts] of edgeCounts) {
    const [from, to] = key.split("->");
    if (counts.coEdit > 0) edges.push({ from, to, type: "co-edit", sharedFiles: counts.coEdit });
    if (counts.coRead > 0) edges.push({ from, to, type: "co-read", sharedFiles: counts.coRead });
  }

  // ── Build structural parent/child maps ──
  const structuralEdges = lineageEdges.length > 0
    ? lineageEdges
    : [...delegationEdgeGroups.entries()]
        .filter(([, grouped]) => grouped.some(t => missionStructuralKinds.has(t.kind)))
        .map(([key]) => {
          const [from, to] = key.split("->");
          return { from, to, type: "delegation" as const };
        });

  const spawnedSet = new Set(structuralEdges.map(e => e.to));
  const childrenOf = new Map<string, string[]>();
  for (const e of structuralEdges) {
    const arr = childrenOf.get(e.from) || [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }

  return { edges, handoffDocs, commitSessionMap, childrenOf, spawnedSet };
}
