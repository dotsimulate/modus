import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { fetchTouches, type TouchRecord, type TouchQuery } from "../api/trace";
import { buildGraph, type TraceGraph, type SessionNode, type FileNode, type TouchEdge, LAYOUT, FILE_X } from "../utils/touch-graph";

// ── Helpers ──

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function edgeOpClass(op: string): string {
  if (op === "write" || op === "edit") return "trace-edge--write";
  if (op === "read") return "trace-edge--read";
  return "trace-edge--search";
}

function edgePath(sessY: number, fileY: number): string {
  const sx = LAYOUT.SESSION_X + LAYOUT.SESSION_WIDTH;
  const sy = sessY + LAYOUT.SESSION_HEIGHT / 2;
  const ex = FILE_X;
  const ey = fileY + LAYOUT.FILE_HEIGHT / 2;
  const mid = (sx + ex) / 2;
  return `M ${sx} ${sy} C ${mid} ${sy}, ${mid} ${ey}, ${ex} ${ey}`;
}

// ── Filter config ──

const OP_OPTIONS = [
  { key: "write", label: "write" },
  { key: "edit",  label: "edit"  },
  { key: "read",  label: "read"  },
];

const TIME_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "7d",  ms: 7  * 86_400_000 },
  { label: "30d", ms: 30 * 86_400_000 },
  { label: "90d", ms: 90 * 86_400_000 },
  { label: "all", ms: null },
];

// ── Main view ──

export function TraceView() {
  const [touches, setTouches]         = useState<TouchRecord[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [activeOps, setActiveOps]     = useState<Set<string>>(new Set(["write", "edit"]));
  const [timeMs, setTimeMs]           = useState<number | null>(30 * 86_400_000);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [hoveredFile, setHoveredFile] = useState<string | null>(null);
  const [selected, setSelected]       = useState<{ type: "session" | "file"; id: string } | null>(null);
  const [pan, setPan]                 = useState({ x: 40, y: 30 });
  const [scale, setScale]             = useState(0.9);

  const isDragging  = useRef(false);
  const dragStart   = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // Fetch on filter change
  const fetchKey = `${[...activeOps].sort().join(",")}|${timeMs}`;
  useEffect(() => {
    setLoading(true);
    const query: TouchQuery = { limit: 3000, ops: [...activeOps] };
    if (timeMs) query.from = Date.now() - timeMs;
    fetchTouches(query)
      .then(r => { setTouches(r.touches); setError(null); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [fetchKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const graph = useMemo(() => buildGraph(touches), [touches]);

  const sessionById = useMemo(
    () => new Map(graph.sessions.map(s => [s.sessionId, s])),
    [graph.sessions],
  );
  const fileByPath = useMemo(
    () => new Map(graph.files.map(f => [f.filePath, f])),
    [graph.files],
  );

  // Pan/zoom handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("[data-trace-node]")) return;
    isDragging.current = true;
    dragStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging.current) return;
    setPan({
      x: dragStart.current.panX + (e.clientX - dragStart.current.x),
      y: dragStart.current.panY + (e.clientY - dragStart.current.y),
    });
  }, []);

  const handleMouseUp = useCallback(() => { isDragging.current = false; }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setScale(s => Math.max(0.25, Math.min(3, s * (e.deltaY > 0 ? 0.9 : 1.1))));
  }, []);

  // Op toggle (always keep at least one active)
  function toggleOp(op: string) {
    setActiveOps(prev => {
      const next = new Set(prev);
      if (next.has(op)) { if (next.size > 1) next.delete(op); }
      else next.add(op);
      return next;
    });
  }

  // Edge opacity logic
  function getEdgeOpacity(edge: TouchEdge): number {
    if (!hoveredSession && !hoveredFile) return edge.opacity;
    const matchS = hoveredSession ? edge.sessionId === hoveredSession : false;
    const matchF = hoveredFile ? edge.filePath === hoveredFile : false;
    if (matchS || matchF) return Math.min(0.85, edge.opacity * 2.5);
    return 0.04;
  }

  const { layout } = graph;
  const selectedSession = selected?.type === "session" ? sessionById.get(selected.id) ?? null : null;
  const selectedFile    = selected?.type === "file"    ? fileByPath.get(selected.id)   ?? null : null;

  return (
    <div className="trace-panel">

      {/* ── Toolbar ── */}
      <div className="trace-toolbar">
        <div className="trace-toolbar-left">
          <span className="trace-toolbar-label">ops</span>
          {OP_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              className={`trace-op-pill trace-op-pill--${key}${activeOps.has(key) ? " active" : ""}`}
              onClick={() => toggleOp(key)}
            >
              {label}
            </button>
          ))}
          <div className="trace-toolbar-sep" />
          {TIME_OPTIONS.map(({ label, ms }) => (
            <button
              key={label}
              className={`trace-time-pill${timeMs === ms ? " active" : ""}`}
              onClick={() => setTimeMs(ms)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="trace-toolbar-right">
          {!loading && !error && graph.sessions.length > 0 && (
            <span className="trace-stats">
              {graph.sessions.length} sessions · {graph.files.length} files · {graph.edges.length} edges
            </span>
          )}
          {loading && <span className="trace-loading">loading…</span>}
          {error && <span className="trace-error">{error}</span>}
        </div>
      </div>

      {/* ── Canvas ── */}
      <div
        className="trace-canvas-wrap"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onWheel={handleWheel}
      >
        <div
          className="trace-canvas"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}
        >
          {/* Column labels */}
          <div className="trace-col-label" style={{ left: layout.sessionX }}>sessions</div>
          <div className="trace-col-label" style={{ left: layout.fileX }}>files</div>

          {/* SVG edge layer */}
          <svg
            className="trace-svg"
            width={layout.svgWidth}
            height={layout.svgHeight}
          >
            {graph.edges.map((edge, i) => {
              const sess = sessionById.get(edge.sessionId);
              const file = fileByPath.get(edge.filePath);
              if (!sess || !file) return null;
              return (
                <path
                  key={`${edge.sessionId}::${edge.filePath}`}
                  className={`trace-edge ${edgeOpClass(edge.dominantOp)}`}
                  d={edgePath(sess.y, file.y)}
                  opacity={getEdgeOpacity(edge)}
                  strokeWidth={0.8 + Math.min(edge.count / 5, 1.6)}
                  style={{ animationDelay: `${i * 5}ms` }}
                />
              );
            })}
          </svg>

          {/* Session nodes */}
          <div className="trace-sessions" style={{ left: layout.sessionX }}>
            {graph.sessions.map(sess => (
              <div
                key={sess.sessionId}
                data-trace-node="session"
                className={`trace-session-node${hoveredSession === sess.sessionId ? " hovered" : ""}${selected?.id === sess.sessionId ? " selected" : ""}`}
                style={{ top: sess.y }}
                onMouseEnter={() => setHoveredSession(sess.sessionId)}
                onMouseLeave={() => setHoveredSession(null)}
                onClick={() => setSelected(s => s?.id === sess.sessionId ? null : { type: "session", id: sess.sessionId })}
              >
                <span className={`trace-provider-dot trace-provider-dot--${sess.provider ?? "unknown"}`} />
                <span className="trace-sess-id">{sess.shortId}</span>
                <span className="trace-sess-time">{formatDate(sess.lastSeen)}</span>
                <span className="trace-sess-count">{sess.touchCount}</span>
              </div>
            ))}
          </div>

          {/* File nodes */}
          <div className="trace-files" style={{ left: layout.fileX }}>
            {graph.files.map(file => (
              <div
                key={file.filePath}
                data-trace-node="file"
                className={`trace-file-node${hoveredFile === file.filePath ? " hovered" : ""}${selected?.id === file.filePath ? " selected" : ""}`}
                style={{ top: file.y }}
                onMouseEnter={() => setHoveredFile(file.filePath)}
                onMouseLeave={() => setHoveredFile(null)}
                onClick={() => setSelected(s => s?.id === file.filePath ? null : { type: "file", id: file.filePath })}
              >
                <span className={`trace-file-dot trace-file-dot--${file.fileKind}`} />
                <span className="trace-file-name">{file.basename}</span>
                <span className="trace-file-dir">{file.dirHint}</span>
                <span className="trace-file-count">{file.touchCount}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Reset view button */}
        <button
          className="trace-reset-btn"
          onClick={() => { setPan({ x: 40, y: 30 }); setScale(0.9); }}
        >
          ⌖
        </button>
      </div>

      {/* ── Detail panel ── */}
      {(selectedSession || selectedFile) && (
        <div className="trace-detail">
          <div className="trace-detail-header">
            <span className="trace-detail-type">{selectedSession ? "session" : "file"}</span>
            <button className="trace-detail-close" onClick={() => setSelected(null)}>×</button>
          </div>
          {selectedSession && (
            <TraceSessionDetail session={selectedSession} graph={graph} />
          )}
          {selectedFile && (
            <TraceFileDetail file={selectedFile} graph={graph} />
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !error && graph.sessions.length === 0 && (
        <div className="trace-empty">no touch data for selected filters</div>
      )}
    </div>
  );
}

// ── Detail sub-components ──

function TraceSessionDetail({ session, graph }: { session: SessionNode; graph: TraceGraph }) {
  const edges = graph.edges
    .filter(e => e.sessionId === session.sessionId)
    .sort((a, b) => b.count - a.count);
  const topFiles = edges
    .slice(0, 10)
    .map(e => graph.files.find(f => f.filePath === e.filePath))
    .filter((f): f is FileNode => !!f);

  return (
    <>
      <div className="trace-detail-id">
        {session.shortId}
        <span className="trace-detail-id-rest">{session.sessionId.slice(8)}</span>
      </div>
      <div className="trace-detail-meta">
        {session.provider && (
          <>
            <span className="trace-detail-provider">{session.provider}</span>
            <span className="trace-detail-sep">·</span>
          </>
        )}
        <span>{formatDate(session.firstSeen)} – {formatDate(session.lastSeen)}</span>
      </div>
      <div className="trace-detail-stat">
        {session.files.length} files · {session.touchCount} touches
      </div>
      {topFiles.length > 0 && (
        <div className="trace-detail-list">
          {topFiles.map(f => (
            <div key={f.filePath} className="trace-detail-item">
              <span className={`trace-file-dot trace-file-dot--${f.fileKind}`} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", marginRight: 5, flexShrink: 0, verticalAlign: "middle" }} />
              {f.basename}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function TraceFileDetail({ file, graph }: { file: FileNode; graph: TraceGraph }) {
  const edges = graph.edges
    .filter(e => e.filePath === file.filePath)
    .sort((a, b) => b.count - a.count);
  const topSessions = edges
    .slice(0, 8)
    .map(e => graph.sessions.find(s => s.sessionId === e.sessionId))
    .filter((s): s is SessionNode => !!s);

  return (
    <>
      <div className="trace-detail-id">{file.basename}</div>
      <div className="trace-detail-path">{file.dirHint}</div>
      <div className="trace-detail-meta">
        <span className={`trace-detail-kind trace-detail-kind--${file.fileKind}`}>{file.fileKind}</span>
        <span className="trace-detail-sep">·</span>
        <span>{file.sessions.length} sessions</span>
      </div>
      <div className="trace-detail-ops">
        {file.writeCount > 0 && <span className="trace-detail-op--write">{file.writeCount}w</span>}
        {file.editCount  > 0 && <span className="trace-detail-op--edit">{file.editCount}e</span>}
        {file.readCount  > 0 && <span className="trace-detail-op--read">{file.readCount}r</span>}
      </div>
      {topSessions.length > 0 && (
        <div className="trace-detail-list">
          {topSessions.map(s => (
            <div key={s.sessionId} className="trace-detail-item">
              <span className={`trace-provider-dot trace-provider-dot--${s.provider ?? "unknown"}`} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", marginRight: 5, verticalAlign: "middle" }} />
              {s.shortId}
              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 9 }}>{formatDate(s.lastSeen)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
