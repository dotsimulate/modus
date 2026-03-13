import type { TouchRecord } from "../api/trace";

// ── Layout constants ──

export const LAYOUT = {
  SESSION_X:    20,
  SESSION_WIDTH: 210,
  SESSION_HEIGHT: 28,
  SESSION_GAP:   6,
  FILE_HEIGHT:  22,
  FILE_GAP:      5,
  FILE_WIDTH:  240,
  EDGE_SPAN:   150,
  CANVAS_PAD_V: 28,   // top padding (room for column header)
  MAX_SESSIONS: 50,
  MAX_FILES:    70,
} as const;

// Left edge of file column in canvas coordinates
export const FILE_X = LAYOUT.SESSION_X + LAYOUT.SESSION_WIDTH + LAYOUT.EDGE_SPAN; // 380

// ── Node types ──

export type SessionNode = {
  sessionId: string;
  shortId: string;
  provider: string | null;
  touchCount: number;
  files: string[];
  firstSeen: number;
  lastSeen: number;
  y: number;
};

export type FileNode = {
  filePath: string;
  basename: string;
  dirHint: string;
  fileKind: "code" | "docs";
  touchCount: number;
  writeCount: number;
  editCount: number;
  readCount: number;
  sessions: string[];
  lastTouched: number;
  y: number;
};

export type TouchEdge = {
  sessionId: string;
  filePath: string;
  count: number;
  writeCount: number;
  editCount: number;
  readCount: number;
  dominantOp: string;
  lastTimestamp: number;
  confidence: "explicit" | "derived" | "heuristic";
  opacity: number;
};

export type TraceGraph = {
  sessions: SessionNode[];
  files: FileNode[];
  edges: TouchEdge[];
  layout: {
    sessionX: number;
    sessionWidth: number;
    sessionHeight: number;
    fileX: number;
    fileWidth: number;
    fileHeight: number;
    svgWidth: number;
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

// ── Graph builder ──

export function buildGraph(touches: TouchRecord[]): TraceGraph {
  const {
    SESSION_HEIGHT, SESSION_GAP, FILE_HEIGHT, FILE_GAP,
    CANVAS_PAD_V, MAX_SESSIONS, MAX_FILES,
  } = LAYOUT;

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
  const fileMap = new Map<string, FileAcc>();
  const edgeMap = new Map<string, EdgeAcc>();

  for (const t of touches) {
    // Normalize timestamp (handle both seconds and ms)
    const ts = t.timestamp < 1e12 ? t.timestamp * 1000 : t.timestamp;

    // Session
    let sess = sessionMap.get(t.sessionId);
    if (!sess) {
      sess = { provider: t.provider, files: new Set(), touchCount: 0, firstSeen: ts, lastSeen: ts };
      sessionMap.set(t.sessionId, sess);
    }
    sess.files.add(t.filePath);
    sess.touchCount++;
    if (ts < sess.firstSeen) sess.firstSeen = ts;
    if (ts > sess.lastSeen) sess.lastSeen = ts;

    // File
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

    // Edge
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

  // Sort sessions: most recent first (index 0 = top of column)
  const sortedSessions = [...sessionMap.entries()]
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .slice(0, MAX_SESSIONS);

  // Sort files: most touched first
  const sortedFiles = [...fileMap.entries()]
    .sort((a, b) => b[1].touchCount - a[1].touchCount)
    .slice(0, MAX_FILES);

  // Build positioned session nodes
  const sessions: SessionNode[] = sortedSessions.map(([sessionId, s], i) => ({
    sessionId,
    shortId: sessionId.slice(0, 8),
    provider: s.provider,
    touchCount: s.touchCount,
    files: [...s.files],
    firstSeen: s.firstSeen,
    lastSeen: s.lastSeen,
    y: CANVAS_PAD_V + i * (SESSION_HEIGHT + SESSION_GAP),
  }));

  // Build positioned file nodes
  const files: FileNode[] = sortedFiles.map(([filePath, f], i) => ({
    filePath,
    basename: basename(filePath),
    dirHint: dirHint(filePath),
    fileKind: f.fileKind,
    touchCount: f.touchCount,
    writeCount: f.writeCount,
    editCount: f.editCount,
    readCount: f.readCount,
    sessions: [...f.sessions],
    lastTouched: f.lastTouched,
    y: CANVAS_PAD_V + i * (FILE_HEIGHT + FILE_GAP),
  }));

  const sessionIndex = new Map(sessions.map((s, i) => [s.sessionId, i]));
  const fileIndex = new Map(files.map((f, i) => [f.filePath, i]));

  // Edge opacity: normalized by max count in result set
  const maxCount = Math.max(...[...edgeMap.values()].map(e => e.count), 1);

  const edges: TouchEdge[] = [];
  for (const [key, e] of edgeMap.entries()) {
    const sep = key.indexOf("::");
    const sessionId = key.slice(0, sep);
    const filePath = key.slice(sep + 2);
    if (!sessionIndex.has(sessionId) || !fileIndex.has(filePath)) continue;

    // Dominant op
    let dominantOp = "write";
    let maxOp = 0;
    for (const [op, cnt] of Object.entries(e.ops)) {
      if (cnt > maxOp) { maxOp = cnt; dominantOp = op; }
    }

    // Worst confidence
    const confidence: TouchEdge["confidence"] = e.confidences.has("heuristic")
      ? "heuristic"
      : e.confidences.has("derived") ? "derived" : "explicit";

    edges.push({
      sessionId,
      filePath,
      count: e.count,
      writeCount: e.writeCount,
      editCount: e.editCount,
      readCount: e.readCount,
      dominantOp,
      lastTimestamp: e.lastTimestamp,
      confidence,
      opacity: 0.1 + (e.count / maxCount) * 0.55,
    });
  }

  const svgHeight = Math.max(
    sessions.length * (SESSION_HEIGHT + SESSION_GAP) + 2 * CANVAS_PAD_V,
    files.length * (FILE_HEIGHT + FILE_GAP) + 2 * CANVAS_PAD_V,
    200,
  );
  const svgWidth = FILE_X + LAYOUT.FILE_WIDTH + LAYOUT.SESSION_X;

  return {
    sessions,
    files,
    edges,
    layout: {
      sessionX: LAYOUT.SESSION_X,
      sessionWidth: LAYOUT.SESSION_WIDTH,
      sessionHeight: SESSION_HEIGHT,
      fileX: FILE_X,
      fileWidth: LAYOUT.FILE_WIDTH,
      fileHeight: FILE_HEIGHT,
      svgWidth,
      svgHeight,
    },
  };
}
