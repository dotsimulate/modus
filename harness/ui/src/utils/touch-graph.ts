import type { TouchRecord } from "../api/trace";

// ── Spatial layout constants ──

export const CANVAS_W = 1400;
export const CANVAS_H = 1200;

// Session temporal arc: two staggered rows across the top
const SESSION_ARC_Y    = 88;    // top row base y
const SESSION_ARC_ROW  = 44;    // row 2 offset
const SESSION_ARC_DIP  = 26;    // parabola depth (bows down at center)
const SESSION_ARC_LEFT  = 100;
const SESSION_ARC_RIGHT = 1300;

// File clusters: ring in the lower field
const CLUSTER_CENTER_X = 700;
const CLUSTER_CENTER_Y = 660;
const CLUSTER_BASE_R   = 280;   // ring radius (scales with cluster count)
const CLUSTER_SCALE_R  = 22;    // added per cluster beyond 4
const FILE_SPIRAL_STEP = 34;    // golden-angle spiral step (px per sqrt-i)
const GOLDEN_ANGLE     = 2.39996; // ~137.5° in radians

const MAX_SESSIONS = 40;
const MAX_FILES    = 80;
const MAX_CLUSTERS = 10;

// ── Node types ──

export type SessionNode = {
  sessionId: string;
  shortId:   string;
  provider:  string | null;
  touchCount: number;
  files:     string[];
  firstSeen: number;
  lastSeen:  number;
  x: number;
  y: number;
};

export type FileNode = {
  filePath:   string;
  basename:   string;
  dirHint:    string;
  dir:        string;    // top-level directory label
  fileKind:   "code" | "docs";
  touchCount: number;
  writeCount: number;
  editCount:  number;
  readCount:  number;
  sessions:   string[];
  lastTouched: number;
  x: number;
  y: number;
};

export type ClusterNode = {
  dir:       string;
  cx:        number;
  cy:        number;
  radius:    number;    // spatial radius of the spiral field
  fileCount: number;
};

export type TouchEdge = {
  sessionId:  string;
  filePath:   string;
  count:      number;
  writeCount: number;
  editCount:  number;
  readCount:  number;
  dominantOp: string;
  lastTimestamp: number;
  confidence: "explicit" | "derived" | "heuristic";
  opacity:    number;
};

export type TraceGraph = {
  sessions: SessionNode[];
  files:    FileNode[];
  edges:    TouchEdge[];
  clusters: ClusterNode[];
  layout: {
    svgWidth:  number;
    svgHeight: number;
  };
};

// ── Path helpers ──

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function dirHint(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return parts.slice(-3, -1).join("/");
}

function topDir(p: string): string {
  return p.split("/")[0] ?? p;
}

// ── Layout helpers ──

function sessionArcPos(index: number, total: number): { x: number; y: number } {
  const t   = total > 1 ? index / (total - 1) : 0.5;
  const row = index % 2;
  const x   = SESSION_ARC_LEFT + t * (SESSION_ARC_RIGHT - SESSION_ARC_LEFT);
  const y   = SESSION_ARC_Y + row * SESSION_ARC_ROW + SESSION_ARC_DIP * 4 * t * (1 - t);
  return { x, y };
}

function clusterCentroid(
  clusterIndex: number,
  totalClusters: number,
  ringR: number,
): { cx: number; cy: number } {
  const angle = (2 * Math.PI * clusterIndex) / totalClusters - Math.PI / 2;
  return {
    cx: CLUSTER_CENTER_X + ringR * Math.cos(angle),
    cy: CLUSTER_CENTER_Y + ringR * Math.sin(angle),
  };
}

function fileInCluster(fileIndex: number, cx: number, cy: number): { x: number; y: number } {
  if (fileIndex === 0) return { x: cx, y: cy };
  const angle = fileIndex * GOLDEN_ANGLE;
  const r     = Math.sqrt(fileIndex) * FILE_SPIRAL_STEP;
  return {
    x: cx + r * Math.cos(angle),
    y: cy + r * Math.sin(angle),
  };
}

// ── Graph builder ──

export function buildGraph(touches: TouchRecord[]): TraceGraph {
  type SessAcc = {
    provider: string | null;
    files: Set<string>;
    touchCount: number;
    firstSeen: number;
    lastSeen: number;
  };
  type FileAcc = {
    fileKind: "code" | "docs";
    sessions: Set<string>;
    touchCount: number;
    writeCount: number;
    editCount: number;
    readCount: number;
    lastTouched: number;
  };
  type EdgeAcc = {
    count: number;
    writeCount: number;
    editCount: number;
    readCount: number;
    ops: Record<string, number>;
    lastTimestamp: number;
    confidences: Set<string>;
  };

  const sessionMap = new Map<string, SessAcc>();
  const fileMap    = new Map<string, FileAcc>();
  const edgeMap    = new Map<string, EdgeAcc>();

  for (const t of touches) {
    const ts = t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp;

    let sess = sessionMap.get(t.sessionId);
    if (!sess) {
      sess = { provider: t.provider, files: new Set(), touchCount: 0, firstSeen: ts, lastSeen: ts };
      sessionMap.set(t.sessionId, sess);
    }
    sess.files.add(t.filePath);
    sess.touchCount++;
    if (ts < sess.firstSeen) sess.firstSeen = ts;
    if (ts > sess.lastSeen)  sess.lastSeen  = ts;

    let file = fileMap.get(t.filePath);
    if (!file) {
      file = { fileKind: t.fileKind, sessions: new Set(), touchCount: 0, writeCount: 0, editCount: 0, readCount: 0, lastTouched: ts };
      fileMap.set(t.filePath, file);
    }
    file.sessions.add(t.sessionId);
    file.touchCount++;
    if (t.op === "write") file.writeCount++;
    else if (t.op === "edit") file.editCount++;
    else if (t.op === "read") file.readCount++;
    if (ts > file.lastTouched) file.lastTouched = ts;

    const key = `${t.sessionId}::${t.filePath}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { count: 0, writeCount: 0, editCount: 0, readCount: 0, ops: {}, lastTimestamp: ts, confidences: new Set() };
      edgeMap.set(key, edge);
    }
    edge.count++;
    if (t.op === "write") edge.writeCount++;
    else if (t.op === "edit") edge.editCount++;
    else if (t.op === "read") edge.readCount++;
    edge.ops[t.op] = (edge.ops[t.op] ?? 0) + 1;
    if (ts > edge.lastTimestamp) edge.lastTimestamp = ts;
    edge.confidences.add(t.confidence);
  }

  // Sessions: sorted oldest → newest for the temporal arc (left = past, right = recent)
  const sortedSessions = [...sessionMap.entries()]
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen)
    .slice(0, MAX_SESSIONS);

  // Files: most touched first
  const sortedFiles = [...fileMap.entries()]
    .sort((a, b) => b[1].touchCount - a[1].touchCount)
    .slice(0, MAX_FILES);

  // ── Directory cluster layout ──

  // Group files by top-level directory; sort dirs by file count
  const dirGroups = new Map<string, Array<[string, FileAcc]>>();
  for (const entry of sortedFiles) {
    const dir = topDir(entry[0]);
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(entry);
  }
  const sortedDirs = [...dirGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_CLUSTERS);

  const N     = sortedDirs.length;
  const ringR = Math.min(400, CLUSTER_BASE_R + Math.max(0, N - 4) * CLUSTER_SCALE_R);

  const clusters: ClusterNode[] = [];
  const files: FileNode[] = [];

  sortedDirs.forEach(([dir, dirFiles], clusterIdx) => {
    const { cx, cy } = clusterCentroid(clusterIdx, N, ringR);
    const maxIdx      = dirFiles.length - 1;
    const spiralR     = maxIdx > 0 ? Math.sqrt(maxIdx) * FILE_SPIRAL_STEP : 0;
    const clusterRadius = Math.max(36, spiralR + 20);

    clusters.push({ dir, cx, cy, radius: clusterRadius, fileCount: dirFiles.length });

    dirFiles.forEach(([filePath, f], fileIdx) => {
      const { x, y } = fileInCluster(fileIdx, cx, cy);
      files.push({
        filePath,
        basename: basename(filePath),
        dirHint:  dirHint(filePath),
        dir,
        fileKind: f.fileKind,
        touchCount: f.touchCount,
        writeCount: f.writeCount,
        editCount:  f.editCount,
        readCount:  f.readCount,
        sessions:   [...f.sessions],
        lastTouched: f.lastTouched,
        x,
        y,
      });
    });
  });

  // ── Session positions ──

  const sessions: SessionNode[] = sortedSessions.map(([sessionId, s], i) => {
    const { x, y } = sessionArcPos(i, sortedSessions.length);
    return {
      sessionId,
      shortId:   sessionId.slice(0, 8),
      provider:  s.provider,
      touchCount: s.touchCount,
      files:     [...s.files],
      firstSeen: s.firstSeen,
      lastSeen:  s.lastSeen,
      x,
      y,
    };
  });

  // ── Edges ──

  const sessionSet = new Set(sessions.map(s => s.sessionId));
  const fileSet    = new Set(files.map(f => f.filePath));
  const maxCount   = Math.max(...[...edgeMap.values()].map(e => e.count), 1);

  const edges: TouchEdge[] = [];
  for (const [key, e] of edgeMap.entries()) {
    const sep       = key.indexOf("::");
    const sessionId = key.slice(0, sep);
    const filePath  = key.slice(sep + 2);
    if (!sessionSet.has(sessionId) || !fileSet.has(filePath)) continue;

    let dominantOp = "write", maxOp = 0;
    for (const [op, cnt] of Object.entries(e.ops)) {
      if (cnt > maxOp) { maxOp = cnt; dominantOp = op; }
    }

    const confidence: TouchEdge["confidence"] = e.confidences.has("heuristic")
      ? "heuristic"
      : e.confidences.has("derived") ? "derived" : "explicit";

    edges.push({
      sessionId,
      filePath,
      count:      e.count,
      writeCount: e.writeCount,
      editCount:  e.editCount,
      readCount:  e.readCount,
      dominantOp,
      lastTimestamp: e.lastTimestamp,
      confidence,
      opacity: 0.08 + (e.count / maxCount) * 0.52,
    });
  }

  return {
    sessions,
    files,
    edges,
    clusters,
    layout: { svgWidth: CANVAS_W, svgHeight: CANVAS_H },
  };
}
