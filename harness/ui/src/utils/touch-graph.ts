import type { TouchRecord } from "../api/trace";

// No layout constants — positions are computed in TraceView (3D canvas)

const MAX_SESSIONS = 60;
const MAX_FILES    = 100;

// ── Node types (data only, no positions) ──

export type SessionNode = {
  sessionId:  string;
  shortId:    string;
  provider:   string | null;
  touchCount: number;
  files:      string[];
  firstSeen:  number;
  lastSeen:   number;
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
};

// ── Path helpers ──

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}
function dirHint(p: string): string {
  const parts = p.split("/");
  return parts.length <= 2 ? p : parts.slice(-3, -1).join("/");
}
function topDir(p: string): string {
  return p.split("/")[0] ?? p;
}

// ── Graph builder ──

export function buildGraph(touches: TouchRecord[]): TraceGraph {
  type SessAcc = { provider: string|null; files: Set<string>; touchCount: number; firstSeen: number; lastSeen: number };
  type FileAcc = { fileKind: "code"|"docs"; sessions: Set<string>; touchCount: number; writeCount: number; editCount: number; readCount: number; lastTouched: number };
  type EdgeAcc = { count: number; writeCount: number; editCount: number; readCount: number; ops: Record<string,number>; lastTimestamp: number; confidences: Set<string> };

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

  // Sessions: every session that touched a shown file, then cap by touchCount
  const relevantSessIds = new Set<string>();
  for (const [fp] of sortedFiles) {
    for (const sid of (fileMap.get(fp)?.sessions ?? [])) relevantSessIds.add(sid);
  }
  const sortedSessions = [...sessionMap.entries()]
    .filter(([id]) => relevantSessIds.has(id))
    .sort((a, b) => b[1].touchCount - a[1].touchCount)
    .slice(0, MAX_SESSIONS)
    .sort((a, b) => a[1].firstSeen - b[1].firstSeen); // re-sort temporal (oldest first)

  const sessions: SessionNode[] = sortedSessions.map(([sessionId, s]) => ({
    sessionId,
    shortId:   sessionId.slice(0, 8),
    provider:  s.provider,
    touchCount: s.touchCount,
    files:     [...s.files],
    firstSeen: s.firstSeen,
    lastSeen:  s.lastSeen,
  }));

  const files: FileNode[] = sortedFiles.map(([filePath, f]) => ({
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
  }));

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
      ? "heuristic" : e.confidences.has("derived") ? "derived" : "explicit";

    edges.push({
      sessionId, filePath,
      count:      e.count,
      writeCount: e.writeCount,
      editCount:  e.editCount,
      readCount:  e.readCount,
      dominantOp,
      lastTimestamp: e.lastTimestamp,
      confidence,
      opacity: 0.1 + (e.count / maxCount) * 0.5,
    });
  }

  return { sessions, files, edges };
}
