import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import { fetchSessionsScoped } from "../api/sessions";
import { fetchGitLog } from "../api/git";
import { API_BASE, authHeaders } from "../api/_fetch";
import { fetchMissionRuns, fetchMissionTransfers, fetchMissionSessions } from "../api/missions";
import type { SessionInfo, GitCommit } from "../api/types";
import type { MissionRunSummary, MissionTransferSummary } from "../api/missions";
import { ChatFileViewer } from "./ChatFileViewer";
import { SessionWindow } from "./SessionWindow";
import { useProfiles } from "../providers/ProfileProvider";

// ── Types ──

type MoveRun = {
  id: number;
  moveName: string;
  sessionId: string;
  mode: string;
  status: string;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
  spawnedSessionId: string | null;
  gatheredContext?: string;
};

type HandoffDoc = {
  path: string;
  filename: string;
  moveRunId: number;
  fromSessionId: string;
  toSessionId: string;
};

type GraphNode = {
  id: string;
  type: "session" | "commit" | "document";
  x: number;
  y: number;
  col: number;
  row: number;
  session?: SessionInfo;
  commit?: GitCommit;
  doc?: HandoffDoc;
  tags?: string[];
  handoffType?: string;
};

type GraphEdge = {
  from: string;
  to: string;
  type: "handoff" | "commit" | "document" | "delegation";
  moveName?: string;
};

type SelectedNode = GraphNode | null;

// ── Layout Config ──

type WebLayoutConfig = {
  rowWidth: number;
  colHeight: number;
  padX: number;
  padY: number;
  commitOffsetX: number;
  siblingGapRows: number;
  rootGapRows: number;
  axisMode: "time-x" | "time-y";
  timeDirection: "ltr" | "rtl";
};

const LAYOUT_DEFAULTS: WebLayoutConfig = {
  rowWidth: 500,
  colHeight: 130,
  padX: 60,
  padY: 60,
  commitOffsetX: 14,
  siblingGapRows: 0.45,
  rootGapRows: 0.75,
  axisMode: "time-x",
  timeDirection: "ltr",
};

const PRESETS: Record<string, WebLayoutConfig> = {
  default: { ...LAYOUT_DEFAULTS },
  compact: { rowWidth: 360, colHeight: 100, padX: 40, padY: 40, commitOffsetX: 10, siblingGapRows: 0.3, rootGapRows: 0.5, axisMode: "time-x", timeDirection: "ltr" },
  wide:    { rowWidth: 640, colHeight: 160, padX: 80, padY: 80, commitOffsetX: 20, siblingGapRows: 0.6, rootGapRows: 1.0, axisMode: "time-x", timeDirection: "ltr" },
};

const STORAGE_KEY = "mo:web-layout";

function loadConfig(): WebLayoutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...LAYOUT_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...LAYOUT_DEFAULTS };
}

function saveConfig(cfg: WebLayoutConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

// ── Helpers ──

function parseTags(tags: string): string[] {
  try { return JSON.parse(tags); }
  catch { return []; }
}

function shortId(id: string) { return id.slice(0, 8); }
function shortHash(h: string) { return h.slice(0, 7); }
function sessionCreatedAt(sessionMap: Map<string, SessionInfo>, sid: string): number {
  return sessionMap.get(sid)?.created_at ?? 0;
}
function commitTimestamp(commit: GitCommit): number {
  const parsed = Date.parse(commit.date);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function timeAgo(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ── Node Dimensions (fixed — not configurable) ──

const NODE_W = 260;
const NODE_H = 84;
const COMMIT_W = 200;
const COMMIT_H = 30;
const DOC_W = 180;
const DOC_H = 32;
const COMMIT_GAP_Y = 6;

// ── Graph Builder ──

function buildGraph(
  sessions: SessionInfo[],
  moveRuns: MoveRun[],
  commits: GitCommit[],
  missionTransfers: MissionTransferSummary[],
  config: WebLayoutConfig,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edges: GraphEdge[] = [];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  // Handoff edges: source → document → spawned (or source → spawned if no doc)
  const handoffMoveRuns = moveRuns
    .filter(r => r.spawnedSessionId && sessionMap.has(r.sessionId) && sessionMap.has(r.spawnedSessionId!));

  const handoffDocs: HandoffDoc[] = [];
  const handoffEdges: GraphEdge[] = [];

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
      handoffEdges.push({ from: r.sessionId, to: r.spawnedSessionId!, type: "handoff", moveName: r.moveName });
    } else {
      const e = { from: r.sessionId, to: r.spawnedSessionId!, type: "handoff" as const, moveName: r.moveName };
      edges.push(e);
      handoffEdges.push(e);
    }
  }

  // Mission delegation edges
  for (const t of missionTransfers) {
    if (!t.fromSessionId || !t.toSessionId) continue;
    if (!sessionMap.has(t.fromSessionId) || !sessionMap.has(t.toSessionId)) continue;
    const e: GraphEdge = { from: t.fromSessionId, to: t.toSessionId, type: "delegation" };
    edges.push(e);
    handoffEdges.push(e);
  }

  // Build commit tag map: hash → session IDs
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

  // Only include commits that are linked to sessions
  const linkedCommits = commits.filter(c =>
    commitSessionMap.has(shortHash(c.hash)) || commitSessionMap.has(c.hash)
  );

  // Commit edges
  for (const c of linkedCommits) {
    const h7 = shortHash(c.hash);
    const linked = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    for (const sid of linked) {
      edges.push({ from: sid, to: `commit:${h7}`, type: "commit" });
    }
  }

  // Compute session depth via BFS
  const spawnedSet = new Set(handoffEdges.map(e => e.to));
  const childrenOf = new Map<string, string[]>();
  for (const e of handoffEdges) {
    const arr = childrenOf.get(e.from) || [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }

  // Sessions that participate in handoffs
  const handoffSessionIds = new Set<string>();
  for (const e of handoffEdges) {
    handoffSessionIds.add(e.from);
    handoffSessionIds.add(e.to);
  }
  // Also include sessions with commit links
  for (const [, sids] of commitSessionMap) {
    for (const sid of sids) handoffSessionIds.add(sid);
  }

  // If no relationships at all, show recent sessions as a simple grid
  const relevantSessionIds = handoffSessionIds.size > 0
    ? handoffSessionIds
    : new Set(sessions.slice(0, 12).map(s => s.id));

  const depth = new Map<string, number>();
  const roots: string[] = [];
  for (const sid of relevantSessionIds) {
    if (!spawnedSet.has(sid)) {
      roots.push(sid);
      depth.set(sid, 0);
    }
  }
  // BFS
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const child of childrenOf.get(cur) || []) {
      if (!depth.has(child)) {
        depth.set(child, d + 1);
        queue.push(child);
      }
    }
  }
  // Orphans (in relevantSessionIds but not reachable) get depth 0
  for (const sid of relevantSessionIds) {
    if (!depth.has(sid)) depth.set(sid, 0);
  }

  // Lay out the handoff forest by subtree so parents stay visually tied to children.
  const childOrderCache = new Map<string, string[]>();
  function orderedChildren(sid: string): string[] {
    const cached = childOrderCache.get(sid);
    if (cached) return cached;
    const ordered = [...(childrenOf.get(sid) || [])]
      .filter(child => relevantSessionIds.has(child))
      .sort((a, b) => {
        const timeDiff = sessionCreatedAt(sessionMap, a) - sessionCreatedAt(sessionMap, b);
        if (timeDiff !== 0) return timeDiff;
        return a.localeCompare(b);
      });
    childOrderCache.set(sid, ordered);
    return ordered;
  }

  const rowPosition = new Map<string, number>();
  const laidOut = new Set<string>();
  function layoutSubtree(sid: string, startRow: number): number {
    laidOut.add(sid);
    const children = orderedChildren(sid).filter(child => !laidOut.has(child));
    if (children.length === 0) {
      rowPosition.set(sid, startRow);
      return startRow + 1;
    }

    let cursor = startRow;
    const childRows: number[] = [];
    for (let index = 0; index < children.length; index++) {
      cursor = layoutSubtree(children[index], cursor);
      childRows.push(rowPosition.get(children[index]) ?? cursor - 1);
      if (index < children.length - 1) cursor += config.siblingGapRows;
    }
    rowPosition.set(sid, (childRows[0] + childRows[childRows.length - 1]) / 2);
    return cursor;
  }

  const orderedRoots = [...roots].sort((a, b) => {
    const timeDiff = sessionCreatedAt(sessionMap, a) - sessionCreatedAt(sessionMap, b);
    if (timeDiff !== 0) return timeDiff;
    return a.localeCompare(b);
  });

  let nextRootRow = 0;
  for (let index = 0; index < orderedRoots.length; index++) {
    nextRootRow = layoutSubtree(orderedRoots[index], nextRootRow);
    if (index < orderedRoots.length - 1) nextRootRow += config.rootGapRows;
  }

  // Guard against malformed/cyclic data so every relevant session still renders.
  const unplaced = [...relevantSessionIds]
    .filter(sid => !rowPosition.has(sid))
    .sort((a, b) => {
      const timeDiff = sessionCreatedAt(sessionMap, a) - sessionCreatedAt(sessionMap, b);
      if (timeDiff !== 0) return timeDiff;
      return a.localeCompare(b);
    });
  for (const sid of unplaced) {
    rowPosition.set(sid, nextRootRow);
    nextRootRow += 1;
  }

  // Axis helpers: map (row, col) to (x, y) based on axisMode
  const toX = (row: number, col: number) =>
    config.axisMode === "time-x"
      ? config.padX + row * config.rowWidth
      : config.padX + col * config.colHeight;
  const toY = (row: number, col: number) =>
    config.axisMode === "time-x"
      ? config.padY + col * config.colHeight
      : config.padY + row * config.rowWidth;

  // Position session nodes
  const nodes: GraphNode[] = [];
  const orderedSessionIds = [...relevantSessionIds].sort((a, b) => {
    const colDiff = (depth.get(a) ?? 0) - (depth.get(b) ?? 0);
    if (colDiff !== 0) return colDiff;
    const rowDiff = (rowPosition.get(a) ?? 0) - (rowPosition.get(b) ?? 0);
    if (rowDiff !== 0) return rowDiff;
    return a.localeCompare(b);
  });
  for (const sid of orderedSessionIds) {
    const s = sessionMap.get(sid)!;
    const col = depth.get(sid) ?? 0;
    const row = rowPosition.get(sid) ?? 0;
    const tags = parseTags(s.tags);
    const handoffType = tags.find(t => t.startsWith("handoff:"))?.slice(8);
    nodes.push({
      id: s.id,
      type: "session",
      x: toX(row, col),
      y: toY(row, col),
      col,
      row,
      session: s,
      tags,
      handoffType,
    });
  }

  // Apply timeDirection RTL flip to session nodes before deriving doc/commit positions
  if (config.timeDirection === "rtl") {
    const sessionNodes = nodes.filter(n => n.type === "session");
    if (config.axisMode === "time-x") {
      const xs = sessionNodes.map(n => n.x);
      const maxX = Math.max(...xs), minX = Math.min(...xs);
      for (const n of sessionNodes) n.x = maxX + minX - n.x;
    } else {
      const ys = sessionNodes.map(n => n.y);
      const maxY = Math.max(...ys), minY = Math.min(...ys);
      for (const n of sessionNodes) n.y = maxY + minY - n.y;
    }
  }

  // Position document nodes — midpoint between source and target sessions
  const sessionNodeMap = new Map(nodes.map(n => [n.id, n]));
  for (const doc of handoffDocs) {
    const fromNode = sessionNodeMap.get(doc.fromSessionId);
    const toNode = sessionNodeMap.get(doc.toSessionId);
    if (!fromNode || !toNode) continue;
    let docX: number, docY: number;
    if (config.axisMode === "time-y") {
      // In time-y, handoff gap is horizontal (depth axis = x)
      const gapStart = fromNode.x + NODE_W;
      const gapEnd = toNode.x;
      docX = gapStart + (gapEnd - gapStart - DOC_W) / 2;
      docY = (fromNode.y + NODE_H / 2 + toNode.y + NODE_H / 2) / 2 - DOC_H / 2;
    } else {
      // In time-x, handoff gap is vertical (depth axis = y)
      const gapStart = fromNode.y + NODE_H;
      const gapEnd = toNode.y;
      docY = gapStart + (gapEnd - gapStart - DOC_H) / 2;
      docX = (fromNode.x + NODE_W / 2 + toNode.x + NODE_W / 2) / 2 - DOC_W / 2;
    }
    nodes.push({
      id: `doc:${doc.moveRunId}`,
      type: "document",
      x: docX,
      y: docY,
      col: fromNode.col,
      row: fromNode.row,
      doc,
    });
  }

  // Position commit nodes — center them beside the most recent linked session.
  const commitsByAnchor = new Map<string, GitCommit[]>();
  for (const c of linkedCommits) {
    const h7 = shortHash(c.hash);
    const linked = (commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [])
      .filter(sid => sessionNodeMap.has(sid));
    if (linked.length === 0) continue;
    const anchorSid = [...linked].sort((a, b) => {
      const depthDiff = (depth.get(a) ?? 0) - (depth.get(b) ?? 0);
      if (depthDiff !== 0) return depthDiff;
      const timeDiff = sessionCreatedAt(sessionMap, a) - sessionCreatedAt(sessionMap, b);
      if (timeDiff !== 0) return timeDiff;
      return a.localeCompare(b);
    }).at(-1)!;
    const arr = commitsByAnchor.get(anchorSid) || [];
    arr.push(c);
    commitsByAnchor.set(anchorSid, arr);
  }

  for (const [anchorSid, commitGroup] of commitsByAnchor) {
    const anchorNode = sessionNodeMap.get(anchorSid);
    if (!anchorNode) continue;
    const orderedCommits = [...commitGroup].sort((a, b) => commitTimestamp(b) - commitTimestamp(a));
    if (config.axisMode === "time-y") {
      // time-y: commits sit below the session, stacked left→right
      const commitY = anchorNode.y + NODE_H + config.commitOffsetX;
      for (let index = 0; index < orderedCommits.length; index++) {
        const c = orderedCommits[index];
        nodes.push({
          id: `commit:${shortHash(c.hash)}`,
          type: "commit",
          x: anchorNode.x + index * (COMMIT_W + COMMIT_GAP_Y),
          y: commitY,
          col: anchorNode.col,
          row: anchorNode.row,
          commit: c,
        });
      }
    } else {
      // time-x: commits sit to the right of the session, stacked top→bottom
      const commitX = anchorNode.x + NODE_W + config.commitOffsetX;
      for (let index = 0; index < orderedCommits.length; index++) {
        const c = orderedCommits[index];
        nodes.push({
          id: `commit:${shortHash(c.hash)}`,
          type: "commit",
          x: commitX,
          y: anchorNode.y + index * (COMMIT_H + COMMIT_GAP_Y),
          col: anchorNode.col,
          row: anchorNode.row,
          commit: c,
        });
      }
    }
  }

  return { nodes, edges };
}

// ── SVG Edge ──

function nodeBottom(n: GraphNode) {
  if (n.type === "session") return n.y + NODE_H;
  if (n.type === "document") return n.y + DOC_H;
  return n.y + COMMIT_H;
}
function nodeMidX(n: GraphNode) {
  if (n.type === "session") return n.x + NODE_W / 2;
  if (n.type === "document") return n.x + DOC_W / 2;
  return n.x + COMMIT_W / 2;
}
function nodeRight(n: GraphNode) {
  if (n.type === "session") return n.x + NODE_W;
  if (n.type === "document") return n.x + DOC_W;
  return n.x + COMMIT_W;
}
function nodeMidY(n: GraphNode) {
  if (n.type === "session") return n.y + NODE_H / 2;
  if (n.type === "document") return n.y + DOC_H / 2;
  return n.y + COMMIT_H / 2;
}

function EdgePath({ from, to, type, axisMode }: {
  from: GraphNode;
  to: GraphNode;
  type: "handoff" | "commit" | "document" | "delegation";
  axisMode: "time-x" | "time-y";
}) {
  if (type === "commit") {
    if (axisMode === "time-y") {
      // time-y: commits sit below sessions — vertical stub at commit center X
      const startY = from.y + NODE_H;
      const midX = to.x + COMMIT_W / 2;
      const d = `M ${midX} ${startY} L ${midX} ${to.y}`;
      return <path d={d} className="web-edge web-edge--commit" />;
    }
    // time-x: commits sit to the right — horizontal stub at commit center Y
    const startX = from.x + NODE_W;
    const midY = to.y + COMMIT_H / 2;
    const d = `M ${startX} ${midY} L ${to.x} ${midY}`;
    return <path d={d} className="web-edge web-edge--commit" />;
  }

  if (type === "document") {
    if (axisMode === "time-y") {
      return (
        <line
          x1={nodeRight(from)} y1={nodeMidY(from)}
          x2={to.x}            y2={nodeMidY(to)}
          className="web-edge web-edge--document"
        />
      );
    }
    return (
      <line
        x1={nodeMidX(from)} y1={nodeBottom(from)}
        x2={nodeMidX(to)}   y2={to.y}
        className="web-edge web-edge--document"
      />
    );
  }

  if (type === "delegation") {
    if (axisMode === "time-y") {
      const x1 = nodeRight(from), y1 = nodeMidY(from);
      const x2 = to.x,            y2 = nodeMidY(to);
      const dx = Math.abs(x2 - x1);
      const cp = Math.min(Math.max(dx * 0.4, 20), dx * 0.45);
      const d = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
      return <path d={d} className="web-edge web-edge--delegation" />;
    }
    const x1 = nodeMidX(from), y1 = nodeBottom(from);
    const x2 = nodeMidX(to),   y2 = to.y;
    const dy = Math.abs(y2 - y1);
    const cp = Math.min(Math.max(dy * 0.4, 20), dy * 0.45);
    const d = `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
    return <path d={d} className="web-edge web-edge--delegation" />;
  }

  if (axisMode === "time-y") {
    // Horizontal cubic bezier — exits right of source, enters left of target
    const x1 = nodeRight(from), y1 = nodeMidY(from);
    const x2 = to.x,            y2 = nodeMidY(to);
    const dx = Math.abs(x2 - x1);
    const cp = Math.min(Math.max(dx * 0.4, 20), dx * 0.45);
    const d = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
    return <path d={d} className="web-edge web-edge--handoff" />;
  }

  // time-x: vertical cubic bezier — exits bottom, enters top
  const x1 = nodeMidX(from), y1 = nodeBottom(from);
  const x2 = nodeMidX(to),   y2 = to.y;
  const dy = Math.abs(y2 - y1);
  const cp = Math.min(Math.max(dy * 0.4, 20), dy * 0.45);
  const d = `M ${x1} ${y1} C ${x1} ${y1 + cp}, ${x2} ${y2 - cp}, ${x2} ${y2}`;
  return <path d={d} className="web-edge web-edge--handoff" />;
}

// ── Mission Filter Panel ──

function MissionFilterPanel({ runs, activeRunId, onChange }: {
  runs: MissionRunSummary[];
  activeRunId: number | null;
  onChange: (runId: number | null) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="web-mission-filter" onMouseDown={e => e.stopPropagation()}>
      <select
        value={activeRunId ?? ""}
        onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">all missions</option>
        {runs.map(r => (
          <option key={r.id} value={r.id}>
            {r.missionName} #{r.id} ({r.status})
          </option>
        ))}
      </select>
    </div>
  );
}

// ── Layout Panel ──

function LayoutPanel({ config, onChange }: {
  config: WebLayoutConfig;
  onChange: (cfg: WebLayoutConfig) => void;
}) {
  const [open, setOpen] = useState(false);

  const set = <K extends keyof WebLayoutConfig>(key: K, value: WebLayoutConfig[K]) =>
    onChange({ ...config, [key]: value });

  const sliders: [string, keyof WebLayoutConfig, number, number, number][] = [
    ["row width",    "rowWidth",       200, 800,  10],
    ["col height",   "colHeight",       80, 400,  10],
    ["pad x",        "padX",            20, 120,   4],
    ["pad y",        "padY",            20, 120,   4],
    ["commit gap",   "commitOffsetX",    4,  60,   2],
    ["sibling gap",  "siblingGapRows",   0,   2,  0.05],
    ["root gap",     "rootGapRows",      0,   2,  0.05],
  ];

  return (
    <div className="web-layout-panel" onMouseDown={e => e.stopPropagation()}>
      <button className="web-layout-toggle" onClick={() => setOpen(o => !o)}>
        layout {open ? "▲" : "▼"}
      </button>
      <div className={`web-layout-body${open ? " web-layout-body--open" : ""}`}>
        <div>
          <div className="web-layout-inner">
            <div className="web-layout-section">
              <div className="web-layout-row">
                <label>axis</label>
                <div className="web-layout-toggles">
                  <button
                    className={config.axisMode === "time-x" ? "active" : ""}
                    onClick={() => set("axisMode", "time-x")}
                  >time-x</button>
                  <button
                    className={config.axisMode === "time-y" ? "active" : ""}
                    onClick={() => set("axisMode", "time-y")}
                  >time-y</button>
                </div>
              </div>
              <div className="web-layout-row">
                <label>direction</label>
                <div className="web-layout-toggles">
                  <button
                    className={config.timeDirection === "ltr" ? "active" : ""}
                    onClick={() => set("timeDirection", "ltr")}
                  >ltr</button>
                  <button
                    className={config.timeDirection === "rtl" ? "active" : ""}
                    onClick={() => set("timeDirection", "rtl")}
                  >rtl</button>
                </div>
              </div>
            </div>
            <div className="web-layout-divider" />
            <div className="web-layout-section">
              {sliders.map(([label, key, min, max, step]) => (
                <div className="web-layout-slider-row" key={key}>
                  <label>{label}</label>
                  <input
                    type="range"
                    min={min} max={max} step={step}
                    value={config[key] as number}
                    onChange={e => set(key, Number(e.target.value))}
                  />
                  <span>{(config[key] as number).toFixed(step < 1 ? 2 : 0)}</span>
                </div>
              ))}
            </div>
            <div className="web-layout-divider" />
            <div className="web-layout-presets">
              {Object.keys(PRESETS).map(name => (
                <button key={name} onClick={() => onChange({ ...PRESETS[name] })}>
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail Panel ──

function DetailPanel({ node, onClose }: { node: GraphNode; onClose: () => void }) {
  if (node.type === "document" && node.doc) {
    const d = node.doc;
    return (
      <div className="web-detail">
        <div className="web-detail-header">
          <span className="web-detail-type">handoff document</span>
          <button className="web-detail-close" onClick={onClose}>&times;</button>
        </div>
        <div className="web-detail-title">{d.filename}</div>
        <div className="web-detail-preview">{d.path}</div>
        <div className="web-detail-meta">
          <span>{shortId(d.fromSessionId)}</span>
          <span className="web-detail-sep">&rarr;</span>
          <span>{shortId(d.toSessionId)}</span>
        </div>
      </div>
    );
  }

  if (node.type === "commit" && node.commit) {
    const c = node.commit;
    return (
      <div className="web-detail">
        <div className="web-detail-header">
          <span className="web-detail-type">commit</span>
          <button className="web-detail-close" onClick={onClose}>&times;</button>
        </div>
        <div className="web-detail-hash">{shortHash(c.hash)}</div>
        <div className="web-detail-msg">{c.message}</div>
        <div className="web-detail-meta">
          <span>{c.author}</span>
          <span className="web-detail-sep">/</span>
          <span>{c.date}</span>
        </div>
        {(c.filesChanged != null) && (
          <div className="web-detail-stats">
            <span>{c.filesChanged} files</span>
            {c.additions != null && <span className="web-detail-add">+{c.additions}</span>}
            {c.deletions != null && <span className="web-detail-del">-{c.deletions}</span>}
          </div>
        )}
      </div>
    );
  }

  const s = node.session;
  if (!s) return null;
  const tags = node.tags || [];

  return (
    <div className="web-detail">
      <div className="web-detail-header">
        <span className="web-detail-type">session</span>
        <button className="web-detail-close" onClick={onClose}>&times;</button>
      </div>
      <div className="web-detail-id">{shortId(s.id)}</div>
      {s.title && <div className="web-detail-title">{s.title}</div>}
      <div className="web-detail-preview">{s.preview || "(no preview)"}</div>
      <div className="web-detail-meta">
        {s.profile && <span className="web-detail-profile">{s.profile}</span>}
        <span className="web-detail-status" data-status={s.status}>{s.status}</span>
        <span>{s.message_count} msgs</span>
        <span>{formatCost(s.total_cost_usd)}</span>
        <span>{timeAgo(s.created_at)}</span>
      </div>
      {node.handoffType && (
        <div className="web-detail-handoff">
          handoff: <span>{node.handoffType}</span>
        </div>
      )}
      {tags.length > 0 && (
        <div className="web-detail-tags">
          {tags.map((t, i) => <span key={i} className="web-detail-tag">{t}</span>)}
        </div>
      )}
    </div>
  );
}

// ── Main Component ──

type Viewport = { x: number; y: number; scale: number };

export function SessionWeb() {
  const { activeUserProfile, activeUP } = useProfiles();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [moveRuns, setMoveRuns] = useState<MoveRun[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [missionRuns, setMissionRuns] = useState<MissionRunSummary[]>([]);
  const [missionTransfers, setMissionTransfers] = useState<MissionTransferSummary[]>([]);
  const [missionFilter, setMissionFilter] = useState<number | null>(null);
  const [missionFilterSessionIds, setMissionFilterSessionIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SelectedNode>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null);
  const [miniSessionId, setMiniSessionId] = useState<string | null>(null);
  const [config, setConfig] = useState<WebLayoutConfig>(() => loadConfig());

  // Canvas viewport state — start with padding so content isn't at origin
  const [viewport, setViewport] = useState<Viewport>(() => {
    const cfg = loadConfig();
    return { x: cfg.padX, y: cfg.padY, scale: 1 };
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; vpX: number; vpY: number } | null>(null);
  const autoCenteredRef = useRef(false);

  // Persist config changes to localStorage
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  // Fetch all data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const projectCwd = activeUP?.projects?.[0];
        const [sessData, moveData, gitData, runsData] = await Promise.all([
          fetchSessionsScoped(100, activeUserProfile ?? undefined),
          fetch(`${API_BASE}/api/move-runs/recent?limit=100`, { headers: authHeaders() }).then(r => r.json()),
          fetchGitLog(projectCwd ?? ".", 50).catch(() => [] as GitCommit[]),
          fetchMissionRuns(projectCwd ? { cwd: projectCwd } : undefined).catch(() => [] as MissionRunSummary[]),
        ]);
        if (cancelled) return;
        setSessions(sessData);
        setMoveRuns(moveData);
        setCommits(gitData);
        setMissionRuns(runsData);
        // Fetch transfers for all runs in parallel
        const transferArrays = await Promise.all(
          runsData.map((r: MissionRunSummary) => fetchMissionTransfers(r.id).catch(() => [])),
        );
        if (!cancelled) {
          setMissionTransfers(transferArrays.flat());
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [activeUserProfile, activeUP]);

  // When mission filter changes, fetch session IDs for that run
  useEffect(() => {
    if (missionFilter === null) {
      setMissionFilterSessionIds(null);
      return;
    }
    let cancelled = false;
    fetchMissionSessions(missionFilter).then(ids => {
      if (!cancelled) setMissionFilterSessionIds(new Set(ids));
    }).catch(() => {
      if (!cancelled) setMissionFilterSessionIds(null);
    });
    return () => { cancelled = true; };
  }, [missionFilter]);

  const filteredSessions = useMemo(() => {
    if (!missionFilterSessionIds) return sessions;
    return sessions.filter(s => missionFilterSessionIds.has(s.id));
  }, [sessions, missionFilterSessionIds]);

  const filteredTransfers = useMemo(() => {
    if (!missionFilter) return missionTransfers;
    return missionTransfers.filter(t => {
      if (!missionFilterSessionIds) return true;
      return (t.fromSessionId && missionFilterSessionIds.has(t.fromSessionId)) ||
             (t.toSessionId && missionFilterSessionIds.has(t.toSessionId));
    });
  }, [missionTransfers, missionFilter, missionFilterSessionIds]);

  const { nodes, edges } = useMemo(
    () => buildGraph(filteredSessions, moveRuns, commits, filteredTransfers, config),
    [filteredSessions, moveRuns, commits, filteredTransfers, config],
  );

  const nodeMap = useMemo(
    () => new Map(nodes.map(n => [n.id, n])),
    [nodes],
  );

  const newestSessionNode = useMemo(() => {
    return nodes
      .filter((node): node is GraphNode & { type: "session"; session: SessionInfo } => node.type === "session" && !!node.session)
      .sort((a, b) => {
        const timeDiff = (a.session?.created_at ?? 0) - (b.session?.created_at ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      })
      .at(-1) ?? null;
  }, [nodes]);

  // Compute SVG viewport
  const svgW = useMemo(() => {
    const maxX = Math.max(...nodes.map(n => n.x + (n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W)), 400);
    return maxX + config.padX;
  }, [nodes, config.padX]);

  const svgH = useMemo(() => {
    const maxY = Math.max(...nodes.map(n => n.y + (n.type === "session" ? NODE_H : n.type === "document" ? DOC_H : COMMIT_H)), 300);
    return maxY + config.padY;
  }, [nodes, config.padY]);

  // Wheel zoom (non-passive to allow preventDefault)
  useEffect(() => {
    if (loading) return;
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setViewport(vp => {
        const s = Math.max(0.15, Math.min(4, vp.scale * factor));
        const r = s / vp.scale;
        return { scale: s, x: mx - r * (mx - vp.x), y: my - r * (my - vp.y) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loading]);

  // Pan handlers
  const onPanStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, vpX: viewport.x, vpY: viewport.y };
  };
  const onPanMove = (e: React.MouseEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const newX = dragRef.current.vpX + dx;
    const newY = dragRef.current.vpY + dy;
    const wrap = wrapRef.current;
    if (wrap) {
      const minX = -(svgW * viewport.scale - 100);
      const minY = -(svgH * viewport.scale - 100);
      const maxX = wrap.clientWidth - 100;
      const maxY = wrap.clientHeight - 100;
      setViewport(vp => ({ ...vp, x: Math.max(minX, Math.min(maxX, newX)), y: Math.max(minY, Math.min(maxY, newY)) }));
    } else {
      setViewport(vp => ({ ...vp, x: newX, y: newY }));
    }
  };
  const onPanEnd = () => { dragRef.current = null; };

  const handleSelect = useCallback((node: GraphNode) => {
    setSelected(prev => prev?.id === node.id ? null : node);
  }, []);

  const handleResetView = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !newestSessionNode) {
      setViewport({ x: config.padX, y: config.padY, scale: 1 });
      return;
    }

    const targetX = newestSessionNode.x + NODE_W / 2;
    const targetY = newestSessionNode.y + NODE_H / 2;
    setViewport({
      x: wrap.clientWidth / 2 - targetX,
      y: wrap.clientHeight / 2 - targetY,
      scale: 1,
    });
  }, [newestSessionNode, config.padX, config.padY]);

  useLayoutEffect(() => {
    if (loading || autoCenteredRef.current || !newestSessionNode) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      handleResetView();
      autoCenteredRef.current = true;
    });
    return () => { cancelled = true; };
  }, [handleResetView, loading, newestSessionNode]);

  // Edges connected to hovered/selected node
  const activeNodeId = hoveredId ?? selected?.id ?? null;
  const activeEdgeSet = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const s = new Set<string>();
    for (const e of edges) {
      if (e.from === activeNodeId || e.to === activeNodeId) {
        s.add(`${e.from}->${e.to}`);
      }
    }
    return s;
  }, [activeNodeId, edges]);

  if (loading) {
    return (
      <div className="web-panel">
        <div className="web-empty">loading...</div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="web-panel">
        <div className="web-empty">no session links yet — handoff sessions to build the web</div>
      </div>
    );
  }

  return (
    <div className="web-panel">
      <div
        className="web-canvas-wrap"
        ref={wrapRef}
        onMouseDown={onPanStart}
        onMouseMove={onPanMove}
        onMouseUp={onPanEnd}
        onMouseLeave={onPanEnd}
      >
        <div
          className="web-canvas"
          style={{
            width: svgW,
            height: svgH,
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          }}
        >
          {/* SVG edge layer */}
          <svg className="web-svg" width={svgW} height={svgH}>
            {edges.map((e, i) => {
              const from = nodeMap.get(e.from);
              const to = nodeMap.get(e.to);
              if (!from || !to) return null;
              const edgeKey = `${e.from}->${e.to}`;
              const active = activeEdgeSet.has(edgeKey);
              return (
                <g key={i} className={active ? "web-edge-active" : ""}>
                  <EdgePath from={from} to={to} type={e.type} axisMode={config.axisMode} />
                </g>
              );
            })}
          </svg>

          {/* Node layer */}
          {nodes.map(node => {
            if (node.type === "document" && node.doc) {
              const d = node.doc;
              return (
                <div
                  key={node.id}
                  className={`web-doc-node${selected?.id === node.id ? " web-node--selected" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => handleSelect(node)}
                  onDoubleClick={() => setFileViewerPath(d.path)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={d.path}
                >
                  <span className="web-doc-icon">&#9654;</span>
                  <span className="web-doc-name">{d.filename.replace(/-handoff\.md$/, "")}</span>
                </div>
              );
            }

            if (node.type === "commit") {
              const c = node.commit!;
              return (
                <div
                  key={node.id}
                  className={`web-commit-node${selected?.id === node.id ? " web-node--selected" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => handleSelect(node)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={c.message}
                >
                  <span className="web-commit-hash">{shortHash(c.hash)}</span>
                  <span className="web-commit-msg">{c.message.split("\n")[0].slice(0, 34)}</span>
                </div>
              );
            }

            const s = node.session!;
            const statusClass = s.status === "running" ? "running" : s.status === "error" ? "error" : "done";
            return (
              <div
                key={node.id}
                className={`web-session-node web-session-node--${statusClass}${selected?.id === node.id ? " web-node--selected" : ""}`}
                style={{ left: node.x, top: node.y }}
                onClick={() => handleSelect(node)}
                onDoubleClick={() => setMiniSessionId(s.id)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="web-session-top">
                  <span className={`web-session-dot web-session-dot--${statusClass}`} />
                  <span className="web-session-id">{shortId(s.id)}</span>
                  <span className="web-session-time">{timeAgo(s.created_at)}</span>
                </div>
                <div className="web-session-title">
                  {(s.title || s.preview || "").slice(0, 48)}
                </div>
                <div className="web-session-meta">
                  {s.profile && <span className="web-session-profile">{s.profile}</span>}
                  {node.handoffType && <span className="web-session-handoff-type">{node.handoffType}</span>}
                  <span>{s.message_count} msgs</span>
                  <span>{formatCost(s.total_cost_usd)}</span>
                </div>
              </div>
            );
          })}
        </div>
        <button
          className="web-reset-btn"
          onMouseDown={e => e.stopPropagation()}
          onClick={handleResetView}
          title="Reset view"
        >⊙</button>
        <MissionFilterPanel
          runs={missionRuns}
          activeRunId={missionFilter}
          onChange={setMissionFilter}
        />
        <LayoutPanel config={config} onChange={setConfig} />
      </div>

      {/* Detail panel */}
      {selected && <DetailPanel node={selected} onClose={() => setSelected(null)} />}

      {/* Session window — double-click a session node to open */}
      <SessionWindow
        sessionId={miniSessionId}
        onClose={() => setMiniSessionId(null)}
        onNavigate={id => {
          const profile = sessions.find(s => s.id === id)?.profile ?? "";
          window.location.hash = profile ? `${profile}/${id}` : id;
        }}
      />

      {/* File viewer for handoff documents */}
      <ChatFileViewer path={fileViewerPath} onClose={() => setFileViewerPath(null)} />
    </div>
  );
}
