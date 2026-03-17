/**
 * SessionWebSolver — connection-based placement solver.
 *
 * Places sessions one at a time in chronological order.
 * Each session's position is determined by its strongest connection
 * to an already-placed session:
 *   1. Direct handoff  (strongest — placed directly off parent)
 *   2. Shared file writes (co-edit — placed nearby)
 *   3. Shared file reads  (co-read — placed loosely nearby)
 *
 * Commits are placed as 2D clusters near the session(s) that produced them.
 * Orphan commits attach to the nearest session that read matching files.
 * Day bands are computed post-hoc from actual node positions.
 */

import type { SessionInfo, GitCommit } from "../api/types";
import type { TouchRecord } from "../api/trace";
import type {
  GraphNode, GraphEdge, HandoffDoc, WebLayoutConfig, PositionMap, TimeCluster,
} from "./SessionWebLayout";
import {
  NODE_W, NODE_H, DOC_W, DOC_H, COMMIT_W, COMMIT_H,
  PAD_NODE_W, PAD_NODE_H, WINDOW_PAD,
  shortHash, parseTags, dayKey, formatDayLabel, stableJitter, commitTimestamp,
} from "./SessionWebLayout";

export type SolverResult = {
  nodes: GraphNode[];
  clusters: TimeCluster[];
};

// ── Connection scoring ──
// Handoffs dominate. If a session has a handoff parent, it ALWAYS wins.

type ConnectionScore = {
  anchorId: string;
  score: number;
  type: "handoff" | "delegation" | "co-edit" | "co-read";
};

function scoreConnections(
  sessionId: string,
  edges: GraphEdge[],
  placed: Map<string, { x: number; y: number }>,
): ConnectionScore | null {
  let best: ConnectionScore | null = null;

  for (const e of edges) {
    let otherId: string | null = null;
    if (e.from === sessionId && placed.has(e.to)) otherId = e.to;
    else if (e.to === sessionId && placed.has(e.from)) otherId = e.from;
    if (!otherId) continue;

    if (e.type === "commit" || e.type === "document") continue;

    let score = 0;
    if (e.type === "handoff") score = 1000;      // handoffs always win
    else if (e.type === "delegation") score = 500;
    else if (e.type === "co-edit") score = 10 * (e.sharedFiles ?? 1);
    else if (e.type === "co-read") score = 2 * (e.sharedFiles ?? 1);

    if (!best || score > best.score) {
      best = { anchorId: otherId, score, type: e.type };
    }
  }

  return best;
}

// ── Collision resolution ──
// Only pushes the new node. Iterates a few times to clear multiple overlaps
// but never moves already-placed nodes.

function resolveCollision(
  newId: string,
  positions: Map<string, { x: number; y: number }>,
  overrides: PositionMap,
  placedOrder?: string[],
  effectiveH?: Map<string, number>,
) {
  const p = positions.get(newId);
  if (!p || overrides[newId]) return;

  const padH = (id: string) => effectiveH?.get(id) ?? PAD_NODE_H;

  // Priority pass: resolve against the last 5 placed nodes first.
  // These are the densest spatial neighbors — clearing them before the general
  // sweep means the general passes start from a better initial position.
  if (placedOrder && placedOrder.length > 0) {
    const last5 = placedOrder.slice(-5);
    for (let pass = 0; pass < 3; pass++) {
      for (const otherId of last5) {
        const op = positions.get(otherId);
        if (!op) continue;
        const overlapX = PAD_NODE_W - Math.abs(p.x - op.x);
        const overlapY = padH(otherId) - Math.abs(p.y - op.y);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapY <= overlapX + 20) {
            p.y += (p.y >= op.y ? overlapY : -overlapY) + 4;
          } else {
            p.x += (p.x >= op.x ? overlapX : -overlapX) + 4;
          }
        }
      }
    }
  }

  // General passes — sweep all placed nodes to catch any remaining overlaps
  for (let pass = 0; pass < 5; pass++) {
    let hadOverlap = false;
    for (const [otherId, op] of positions) {
      if (otherId === newId) continue;
      const overlapX = PAD_NODE_W - Math.abs(p.x - op.x);
      const overlapY = padH(otherId) - Math.abs(p.y - op.y);
      if (overlapX > 0 && overlapY > 0) {
        hadOverlap = true;
        // Prefer pushing in Y to keep time-X alignment
        if (overlapY <= overlapX + 20) {
          p.y += (p.y >= op.y ? overlapY : -overlapY) + 4;
        } else {
          p.x += (p.x >= op.x ? overlapX : -overlapX) + 4;
        }
      }
    }
    if (!hadOverlap) break;
  }
}

// ── Main solver ──

export function solveLayout(
  sessions: SessionInfo[],
  edges: GraphEdge[],
  handoffDocs: HandoffDoc[],
  commitSessionMap: Map<string, string[]>,
  childrenOf: Map<string, string[]>,
  spawnedSet: Set<string>,
  commits: GitCommit[],
  config: WebLayoutConfig,
  fixedPositions?: PositionMap,
  touches?: TouchRecord[],
): SolverResult {
  // fixedPositions: positions already stored in the DB. Sessions with a fixed position
  // are placed at that position (as immovable anchors). Sessions WITHOUT a fixed position
  // get solved relative to the fixed ones. This makes the solver incremental — it only
  // computes positions for new/unsolved nodes.
  const fixed = fixedPositions ?? {};
  const sorted = [...sessions].sort((a, b) => a.created_at - b.created_at);

  // ── Time baseline ──
  const allTimes = sorted.map(s => s.created_at);
  const minTime = allTimes.length > 0 ? Math.min(...allTimes) : Date.now();
  const maxTime = allTimes.length > 0 ? Math.max(...allTimes) : Date.now();
  const timeSpan = Math.max(maxTime - minTime, 60000);
  const canvasW = Math.max(sorted.length * config.rowWidth * 0.5, 800);

  function timeToX(ts: number): number {
    return config.padX + ((ts - minTime) / timeSpan) * canvasW;
  }

  // ── Pre-build handoff parent map for fast lookup ──
  // A session's handoff parent is the session that spawned it via handoff edge
  const handoffParent = new Map<string, string>();
  for (const e of edges) {
    if (e.type === "handoff") {
      // e.from spawned e.to (or the other direction via lineage)
      // Check if e.to is a session (not a doc node)
      if (sorted.some(s => s.id === e.to) && sorted.some(s => s.id === e.from)) {
        if (!handoffParent.has(e.to)) handoffParent.set(e.to, e.from);
      }
    }
  }

  // ── Pre-compute commit counts per session (used for effective-height in collision) ──
  // Commits are drawn BELOW their parent session, so a session with many commits
  // occupies more vertical space than NODE_H alone. We pre-compute this so the
  // collision resolver can treat such sessions as taller obstacles.
  const COMMIT_COLS = 3;
  const sessionCommitCounts = new Map<string, number>();
  for (const c of commits) {
    const h7 = shortHash(c.hash);
    const parentSids = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    if (parentSids.length > 0) {
      const pid = parentSids[0];
      sessionCommitCounts.set(pid, (sessionCommitCounts.get(pid) ?? 0) + 1);
    }
  }
  // effectiveH: PAD_NODE_H + rows of commits below the session (+ gap)
  const effectiveH = new Map<string, number>();
  for (const [sid, count] of sessionCommitCounts) {
    const rows = Math.ceil(count / COMMIT_COLS);
    effectiveH.set(sid, PAD_NODE_H + rows * (COMMIT_H + 6) + 18);
  }

  // ── Track how many children each parent has placed so far ──
  const childCounters = new Map<string, number>();

  // ── Place sessions one at a time ──
  const placed = new Map<string, { x: number; y: number }>();
  const placedOrder: string[] = []; // insertion-order list for last-N priority in collision
  let nextRootY = config.padY + 40;

  // Pre-seed placed map with fixed positions (already stored in DB)
  for (const s of sorted) {
    if (fixed[s.id]) {
      placed.set(s.id, { x: fixed[s.id].x, y: fixed[s.id].y });
      placedOrder.push(s.id);
    }
  }

  for (const s of sorted) {
    // Skip sessions that already have fixed positions
    if (fixed[s.id]) continue;

    const conn = scoreConnections(s.id, edges, placed);

    let x: number;
    let y: number;

    if (conn && (conn.type === "handoff" || conn.type === "delegation")) {
      // Place directly off the parent session — handoffs are king
      const anchor = placed.get(conn.anchorId)!;
      const counter = childCounters.get(conn.anchorId) ?? 0;
      childCounters.set(conn.anchorId, counter + 1);

      x = anchor.x + NODE_W + 50;
      y = anchor.y + counter * (NODE_H + 16) + stableJitter(s.id, 5);

    } else if (conn && conn.type === "co-edit") {
      const anchor = placed.get(conn.anchorId)!;
      const anchorCommitH = effectiveH.get(conn.anchorId) ?? PAD_NODE_H;
      x = timeToX(s.created_at);
      y = anchor.y + anchorCommitH + 12 + stableJitter(s.id, 10);

    } else if (conn && conn.type === "co-read") {
      const anchor = placed.get(conn.anchorId)!;
      const anchorCommitH = effectiveH.get(conn.anchorId) ?? PAD_NODE_H;
      x = timeToX(s.created_at);
      y = anchor.y + anchorCommitH + 6 + stableJitter(s.id, NODE_H * 0.3);

    } else {
      // No connection — root session
      // Instead of drifting down forever, place at a consistent Y band
      // based on the session's time-neighborhood
      x = timeToX(s.created_at);

      // Try to find a nearby session in time and place at similar Y
      let nearbyY: number | null = null;
      let nearbyId: string | null = null;
      const TIME_NEARBY = 3600000 * 3; // 3 hours
      for (const [pid, pp] of placed) {
        const ps = sorted.find(ss => ss.id === pid);
        if (!ps) continue;
        if (Math.abs(ps.created_at - s.created_at) < TIME_NEARBY) {
          nearbyY = pp.y;
          nearbyId = pid;
          break;
        }
      }

      if (nearbyY !== null) {
        const nearbyCommitH = nearbyId ? (effectiveH.get(nearbyId) ?? PAD_NODE_H) : PAD_NODE_H;
        y = nearbyY + nearbyCommitH + 10 + stableJitter(s.id, 10);
      } else {
        y = nextRootY;
        nextRootY += NODE_H + 40;
      }
    }

    placed.set(s.id, { x, y });
    resolveCollision(s.id, placed, {}, placedOrder, effectiveH);
    placedOrder.push(s.id);
  }

  // ── Build session nodes ──
  const nodes: GraphNode[] = [];
  for (const s of sorted) {
    const p = placed.get(s.id)!;
    const tags = parseTags(s.tags);
    const handoffType = tags.find(t => t.startsWith("handoff:"))?.slice(8);
    const depth = spawnedSet.has(s.id) ? 1 : 0;
    nodes.push({
      id: s.id,
      type: "session",
      x: p.x,
      y: p.y,
      col: depth,
      row: 0,
      session: s,
      tags,
      handoffType,
      dayKey: dayKey(s.created_at),
    });
  }

  // ── Place commits near parent sessions ──
  const commitsByParent = new Map<string, GitCommit[]>();
  const orphanCommits: GitCommit[] = [];

  // Build a file->session map from touches for orphan commit matching
  const fileToSessions = new Map<string, Set<string>>();
  if (touches) {
    for (const t of touches) {
      if (t.op !== "read" && t.op !== "write" && t.op !== "edit") continue;
      const set = fileToSessions.get(t.filePath) || new Set();
      set.add(t.sessionId);
      fileToSessions.set(t.filePath, set);
    }
  }

  for (const c of commits) {
    const h7 = shortHash(c.hash);
    const parentSids = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    if (parentSids.length > 0) {
      const pid = parentSids[0];
      const arr = commitsByParent.get(pid) || [];
      arr.push(c);
      commitsByParent.set(pid, arr);
    } else {
      orphanCommits.push(c);
    }
  }

  // Place each parent's commits in a small 2D grid below-right of the session
  for (const [pid, pCommits] of commitsByParent) {
    const parentPos = placed.get(pid);
    if (!parentPos) continue;
    const sortedC = [...pCommits].sort((a, b) => commitTimestamp(a) - commitTimestamp(b));
    for (let i = 0; i < sortedC.length; i++) {
      const col = i % COMMIT_COLS;
      const row = Math.floor(i / COMMIT_COLS);
      const cx = parentPos.x + config.commitOffsetX + col * (COMMIT_W + 8);
      const cy = parentPos.y + NODE_H + 14 + row * (COMMIT_H + 6);
      nodes.push({
        id: `commit:${shortHash(sortedC[i].hash)}`,
        type: "commit",
        x: cx, y: cy,
        col, row,
        commit: sortedC[i],
        dayKey: dayKey(commitTimestamp(sortedC[i])),
      });
    }
  }

  // Orphan commits: try to attach to a session that read/wrote matching files
  // Otherwise place near the closest session in time
  for (const c of orphanCommits) {
    const ct = commitTimestamp(c);
    let bestSid: string | null = null;
    let bestDist = Infinity;

    // Find nearest session in time
    for (const s of sorted) {
      const dist = Math.abs(s.created_at - ct);
      if (dist < bestDist && placed.has(s.id)) {
        bestDist = dist;
        bestSid = s.id;
      }
    }

    if (bestSid && placed.has(bestSid)) {
      const sp = placed.get(bestSid)!;
      // Place near that session, offset to the right
      const existingCommits = nodes.filter(
        n => n.type === "commit" && Math.abs(n.x - sp.x) < NODE_W * 2 && Math.abs(n.y - (sp.y + NODE_H)) < 100,
      );
      const idx = existingCommits.length;
      const col = idx % COMMIT_COLS;
      const row = Math.floor(idx / COMMIT_COLS);
      nodes.push({
        id: `commit:${shortHash(c.hash)}`,
        type: "commit",
        x: sp.x + config.commitOffsetX + col * (COMMIT_W + 8),
        y: sp.y + NODE_H + 14 + row * (COMMIT_H + 6),
        col, row,
        commit: c,
        dayKey: dayKey(ct),
      });
    } else {
      // Absolute fallback
      nodes.push({
        id: `commit:${shortHash(c.hash)}`,
        type: "commit",
        x: config.padX, y: config.padY,
        col: 0, row: 0,
        commit: c,
        dayKey: dayKey(ct),
      });
    }
  }

  // ── Place document nodes (midpoint between linked sessions) ──
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const doc of handoffDocs) {
    const fromNode = nodeMap.get(doc.fromSessionId);
    const toNode = nodeMap.get(doc.toSessionId);
    if (!fromNode || !toNode) continue;
    const docX = (fromNode.x + NODE_W / 2 + toNode.x + NODE_W / 2) / 2 - DOC_W / 2;
    const docY = (fromNode.y + NODE_H / 2 + toNode.y + NODE_H / 2) / 2 - DOC_H / 2;
    nodes.push({
      id: `doc:${doc.moveRunId}`,
      type: "document",
      x: docX, y: docY,
      col: fromNode.col, row: fromNode.row,
      doc,
    });
  }

  // ── RTL flip ──
  if (config.timeDirection === "rtl") {
    const movable = nodes;
    const xs = movable.map(n => n.x);
    if (xs.length > 0) {
      const maxXr = Math.max(...xs);
      const minXr = Math.min(...xs);
      for (const n of movable) n.x = maxXr + minXr - n.x;
    }
  }

  // ── Build day clusters from actual positions ──
  const dayGroups = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const dk = n.dayKey ?? (n.commit ? dayKey(commitTimestamp(n.commit)) : null);
    if (!dk) continue;
    const arr = dayGroups.get(dk) || [];
    arr.push(n);
    dayGroups.set(dk, arr);
  }

  const clusters: TimeCluster[] = [];
  const sortedDays = [...dayGroups.keys()].sort();
  for (let di = 0; di < sortedDays.length; di++) {
    const dk = sortedDays[di];
    const dayNodes = dayGroups.get(dk)!;

    let minX = Infinity, maxX = -Infinity;
    let sessionCount = 0, commitCount = 0;
    for (const n of dayNodes) {
      const w = n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W;
      if (n.x < minX) minX = n.x;
      if (n.x + w > maxX) maxX = n.x + w;
      if (n.type === "session") sessionCount++;
      if (n.type === "commit") commitCount++;
    }

    clusters.push({
      id: `cluster:${di}`,
      label: formatDayLabel(dk),
      x: minX - WINDOW_PAD,
      width: (maxX - minX) + WINDOW_PAD * 2,
      sessionCount,
      commitCount,
    });
  }

  return { nodes, clusters };
}

