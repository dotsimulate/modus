import type { TouchRecord } from "../api/trace";

// ── Canvas constants ──

export const CANVAS_W = 1400;
export const CANVAS_H = 1100;

// Session arc band: two staggered rows across the top
const SESSION_ARC_LEFT  = 120;
const SESSION_ARC_RIGHT = 1280;
const SESSION_ROW_Y = [90, 132]; // y per row (row = index % 2)

// File cluster seed positions: ring in the lower field
// (used as initialization + mild anchor for force sim)
const CLUSTER_CENTER_X = 700;
const CLUSTER_CENTER_Y = 620;
const CLUSTER_SEED_R   = 280;   // ring radius, scales with cluster count

const MAX_SESSIONS = 40;
const MAX_FILES    = 80;
const MAX_CLUSTERS = 10;

// ── Force simulation constants ──

const SIM_ITER   = 70;
const REP_K      = 85_000;   // node-node repulsion
const SPR_K      = 0.007;    // edge spring attraction (per unit of log-count weight)
const SESS_ANC_K = 0.18;     // session pull toward temporal arc position (strong)
const FILE_ANC_K = 0.022;    // file pull toward cluster seed centroid (gentle)
const DAMP       = 0.55;     // velocity damping per step

// ── Node types ──

export type SessionNode = {
  sessionId:  string;
  shortId:    string;
  provider:   string | null;
  touchCount: number;
  files:      string[];
  firstSeen:  number;
  lastSeen:   number;
  x: number;
  y: number;
};

export type FileNode = {
  filePath:   string;
  basename:   string;
  dirHint:    string;
  dir:        string;
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
  radius:    number;
  fileCount: number;
};

export type TouchEdge = {
  sessionId:     string;
  filePath:      string;
  count:         number;
  writeCount:    number;
  editCount:     number;
  readCount:     number;
  dominantOp:    string;
  lastTimestamp: number;
  confidence:    "explicit" | "derived" | "heuristic";
  opacity:       number;
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

// Deterministic jitter from a string — avoids random layout changes on re-render
function stableJitter(seed: string, scale: number, offset: number): number {
  let h = offset;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 0x9e3779b9);
    h ^= h >>> 16;
  }
  return ((h >>> 0) / 0xffffffff) * scale * 2 - scale;
}

// ── Graph builder ──

export function buildGraph(touches: TouchRecord[]): TraceGraph {
  type SessAcc = {
    provider:   string | null;
    files:      Set<string>;
    touchCount: number;
    firstSeen:  number;
    lastSeen:   number;
  };
  type FileAcc = {
    fileKind:   "code" | "docs";
    sessions:   Set<string>;
    touchCount: number;
    writeCount: number;
    editCount:  number;
    readCount:  number;
    lastTouched: number;
  };
  type EdgeAcc = {
    count:      number;
    writeCount: number;
    editCount:  number;
    readCount:  number;
    ops:        Record<string, number>;
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
    if (t.op === "write")     file.writeCount++;
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
    if (t.op === "write")     edge.writeCount++;
    else if (t.op === "edit") edge.editCount++;
    else if (t.op === "read") edge.readCount++;
    edge.ops[t.op] = (edge.ops[t.op] ?? 0) + 1;
    if (ts > edge.lastTimestamp) edge.lastTimestamp = ts;
    edge.confidences.add(t.confidence);
  }

  // Files: top by touchCount
  const sortedFiles = [...fileMap.entries()]
    .sort((a, b) => b[1].touchCount - a[1].touchCount)
    .slice(0, MAX_FILES);

  // Sessions: include every session that touched any shown file.
  // This guarantees no orphan file nodes. Cap per-file at MAX_SESSIONS total,
  // prioritising sessions with the most total touches.
  const relevantSessionIds = new Set<string>();
  for (const [fp] of sortedFiles) {
    const f = fileMap.get(fp);
    if (f) for (const sid of f.sessions) relevantSessionIds.add(sid);
  }
  const sortedSessions = [...sessionMap.entries()]
    .filter(([id]) => relevantSessionIds.has(id))
    .sort((a, b) => b[1].touchCount - a[1].touchCount)
    .slice(0, MAX_SESSIONS)
    // Re-sort by firstSeen ascending for temporal arc placement (left = oldest)
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen);

  // ── Directory grouping ──

  const dirGroups = new Map<string, Array<[string, FileAcc]>>();
  for (const entry of sortedFiles) {
    const dir = topDir(entry[0]);
    if (!dirGroups.has(dir)) dirGroups.set(dir, []);
    dirGroups.get(dir)!.push(entry);
  }
  const sortedDirs = [...dirGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, MAX_CLUSTERS);
  const N = sortedDirs.length;

  // Seed centroids: ring arrangement (used only for force init + mild anchor)
  const clusterSeedR = Math.min(380, CLUSTER_SEED_R + Math.max(0, N - 4) * 22);
  const seedCentroid = (idx: number) => {
    const angle = (2 * Math.PI * idx / Math.max(N, 1)) - Math.PI / 2;
    return {
      x: CLUSTER_CENTER_X + clusterSeedR * Math.cos(angle),
      y: CLUSTER_CENTER_Y + clusterSeedR * Math.sin(angle),
    };
  };

  // Map file -> dir index for seed anchor
  const fileDirIdx = new Map<string, number>();
  sortedDirs.forEach(([dir], i) => {
    dirGroups.get(dir)?.forEach(([fp]) => fileDirIdx.set(fp, i));
  });

  // ── Force simulation ──

  type MNode = { x: number; y: number; vx: number; vy: number };

  // Session target positions (temporal arc, two staggered rows)
  const NS = sortedSessions.length;
  const sessTargets = sortedSessions.map(([, s], i) => {
    const t = NS > 1 ? i / (NS - 1) : 0.5;
    return {
      x: SESSION_ARC_LEFT + t * (SESSION_ARC_RIGHT - SESSION_ARC_LEFT),
      y: SESSION_ROW_Y[i % 2],
    };
  });

  // Initialize mutable nodes
  const mnodes: MNode[] = [];

  // Sessions: start at target
  for (const tgt of sessTargets) {
    mnodes.push({ x: tgt.x, y: tgt.y, vx: 0, vy: 0 });
  }

  // Files: start near cluster seed centroid with stable jitter
  const fileEntries = sortedFiles; // [filePath, FileAcc][]
  for (const [fp] of fileEntries) {
    const di = fileDirIdx.get(fp) ?? 0;
    const seed = seedCentroid(di);
    mnodes.push({
      x: seed.x + stableJitter(fp, 40, 1),
      y: seed.y + stableJitter(fp, 40, 2),
      vx: 0,
      vy: 0,
    });
  }

  // Build spring list from edge map
  const sessIdxMap = new Map<string, number>();
  sortedSessions.forEach(([id], i) => sessIdxMap.set(id, i));
  const fileIdxMap = new Map<string, number>();
  fileEntries.forEach(([fp], i) => fileIdxMap.set(fp, NS + i));

  const springs: Array<{ a: number; b: number; w: number }> = [];
  for (const [key, e] of edgeMap.entries()) {
    const sep = key.indexOf("::");
    const si = sessIdxMap.get(key.slice(0, sep));
    const fi = fileIdxMap.get(key.slice(sep + 2));
    if (si === undefined || fi === undefined) continue;
    springs.push({ a: si, b: fi, w: Math.log1p(e.count) });
  }

  // Iterate
  for (let iter = 0; iter < SIM_ITER; iter++) {
    // Zero velocities (overdamped gradient step)
    for (const n of mnodes) { n.vx = 0; n.vy = 0; }

    // All-pairs repulsion
    for (let i = 0; i < mnodes.length; i++) {
      for (let j = i + 1; j < mnodes.length; j++) {
        const dx = mnodes[j].x - mnodes[i].x || 0.01;
        const dy = mnodes[j].y - mnodes[i].y || 0.01;
        const d2  = Math.max(dx * dx + dy * dy, 400); // floor at r=20
        const inv = 1 / Math.sqrt(d2);
        const f   = REP_K * inv * inv * inv; // K / r^2, directed
        mnodes[i].vx -= f * dx;
        mnodes[i].vy -= f * dy;
        mnodes[j].vx += f * dx;
        mnodes[j].vy += f * dy;
      }
    }

    // Edge springs: attract session ↔ file proportional to log-count weight
    for (const { a, b, w } of springs) {
      const dx = mnodes[b].x - mnodes[a].x;
      const dy = mnodes[b].y - mnodes[a].y;
      const f  = SPR_K * w;
      mnodes[a].vx += f * dx;
      mnodes[a].vy += f * dy;
      mnodes[b].vx -= f * dx;
      mnodes[b].vy -= f * dy;
    }

    // Session anchors: strong pull to temporal arc position
    for (let i = 0; i < NS; i++) {
      mnodes[i].vx += (sessTargets[i].x - mnodes[i].x) * SESS_ANC_K;
      mnodes[i].vy += (sessTargets[i].y - mnodes[i].y) * SESS_ANC_K;
    }

    // File anchors: gentle pull toward seed cluster centroid
    for (let i = NS; i < mnodes.length; i++) {
      const di   = fileDirIdx.get(fileEntries[i - NS][0]) ?? 0;
      const seed = seedCentroid(di);
      mnodes[i].vx += (seed.x - mnodes[i].x) * FILE_ANC_K;
      mnodes[i].vy += (seed.y - mnodes[i].y) * FILE_ANC_K;
    }

    // Apply
    for (const n of mnodes) {
      n.x += n.vx * DAMP;
      n.y += n.vy * DAMP;
    }
  }

  // ── Build final node arrays from sim positions ──

  const sessions: SessionNode[] = sortedSessions.map(([sessionId, s], i) => ({
    sessionId,
    shortId:   sessionId.slice(0, 8),
    provider:  s.provider,
    touchCount: s.touchCount,
    files:     [...s.files],
    firstSeen: s.firstSeen,
    lastSeen:  s.lastSeen,
    x: mnodes[i].x,
    y: mnodes[i].y,
  }));

  const files: FileNode[] = fileEntries.map(([filePath, f], i) => ({
    filePath,
    basename: basename(filePath),
    dirHint:  dirHint(filePath),
    dir:      topDir(filePath),
    fileKind: f.fileKind,
    touchCount: f.touchCount,
    writeCount: f.writeCount,
    editCount:  f.editCount,
    readCount:  f.readCount,
    sessions:   [...f.sessions],
    lastTouched: f.lastTouched,
    x: mnodes[NS + i].x,
    y: mnodes[NS + i].y,
  }));

  // ── Cluster centroids from final file positions ──

  const cAcc = new Map<string, { sx: number; sy: number; n: number }>();
  for (const f of files) {
    const a = cAcc.get(f.dir) ?? { sx: 0, sy: 0, n: 0 };
    a.sx += f.x; a.sy += f.y; a.n++;
    cAcc.set(f.dir, a);
  }

  const clusters: ClusterNode[] = sortedDirs.map(([dir, dirFiles]) => {
    const a  = cAcc.get(dir);
    const cx = a ? a.sx / a.n : CLUSTER_CENTER_X;
    const cy = a ? a.sy / a.n : CLUSTER_CENTER_Y;
    let maxR = 28;
    for (const f of files) {
      if (f.dir !== dir) continue;
      const dx = f.x - cx, dy = f.y - cy;
      maxR = Math.max(maxR, Math.sqrt(dx * dx + dy * dy));
    }
    return { dir, cx, cy, radius: maxR + 22, fileCount: dirFiles.length };
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
      opacity: 0.09 + (e.count / maxCount) * 0.5,
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
