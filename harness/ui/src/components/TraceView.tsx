import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { fetchTouches, type TouchRecord } from "../api/trace";
import { buildGraph, type TraceGraph, type SessionNode, type FileNode } from "../utils/touch-graph";

// ── 3D Math ──

type Vec3 = { x: number; y: number; z: number };

function rotateY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c };
}
function rotateX(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c };
}
function project(v: Vec3, w: number, h: number, camZ: number) {
  const fov = 600, z = v.z - camZ, d = fov / (fov + z);
  return { sx: v.x * d + w * 0.5, sy: v.y * d + h / 2, scale: Math.max(0.1, d) };
}

// ── Seeded random ──

function seededRandom(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Particle ──

type TraceParticle = {
  id:           string;
  kind:         "session" | "file";
  pos:          Vec3;
  vel:          Vec3;
  target:       Vec3;
  color:        string;
  age:          number;
  visibleSince: number;   // frame when this particle first appeared
  data:         SessionNode | FileNode;
};

const SPRING        = 0.012;
const DAMPING       = 0.88;
const INITIAL_CAMERA = { rotY: 0.3, rotX: -0.15, camZ: -220, panX: 0, panY: 0, autoRotate: true };
const MIN_CAM_Z     = -2800;
const MAX_CAM_Z     = 720;
const ENTRANCE_FRAMES = 50;

// ── Colors ──

function providerColor(p: string | null): string {
  switch (p) {
    case "claude": return "#b44dff";
    case "gemini": return "#5090ff";
    case "codex":  return "#33cc33";
    case "pi":     return "#e89b50";
    default:       return "#555555";
  }
}
function fileColor(kind: "code" | "docs"): string {
  return kind === "code" ? "#5090ff" : "#e89b50";
}

// ── Layout ──
//
// Sessions are positioned by their TIMESTAMP within the selected date range.
// Position is locked to (firstSeen - rangeStart) / (rangeEnd - rangeStart).
// They never move — the spatial span always reflects the full selected range.
//
// Files are positioned by centroid of their CURRENTLY ACTIVE session connections.
// They drift as playhead reveals more sessions.

function computeSessionTargets(
  sessions: SessionNode[],
  rangeStart: number,
  rangeEnd: number,
): Map<string, Vec3> {
  const result = new Map<string, Vec3>();
  const span   = rangeEnd - rangeStart || 1;

  for (const sess of sessions) {
    const t   = Math.max(0, Math.min(1, (sess.firstSeen - rangeStart) / span));
    const pos = { x: (t - 0.5) * 1100, y: 70, z: (1 - t) * 520 };
    result.set("s:" + sess.sessionId, pos);
  }
  return result;
}

function computeFileTargets(
  files:          FileNode[],
  edges:          TraceGraph["edges"],
  sessionTargets: Map<string, Vec3>,
): Map<string, Vec3> {
  const result = new Map<string, Vec3>();

  for (const file of files) {
    let cx = 0, cz = 0, cnt = 0;
    for (const e of edges) {
      if (e.filePath !== file.filePath) continue;
      const sp = sessionTargets.get("s:" + e.sessionId);
      if (sp) { cx += sp.x; cz += sp.z; cnt++; }
    }
    if (cnt > 0) { cx /= cnt; cz /= cnt; }

    const seed = file.filePath.split("").reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 17);
    const rng  = seededRandom(seed);
    result.set("f:" + file.filePath, {
      x: cx + (rng() - 0.5) * 220,
      y: -55 + (rng() - 0.5) * 55,
      z: cz  + (rng() - 0.5) * 220,
    });
  }
  return result;
}

// ── Op filter ──

const OP_OPTIONS = [
  { key: "write", label: "write" },
  { key: "edit",  label: "edit"  },
  { key: "read",  label: "read"  },
];

// ── Speed slider (log scale) ──

const SPEED_MIN_MS = 15 * 60_000;      // 15 min/s
const SPEED_MAX_MS = 7  * 86_400_000;  // 7 days/s

function speedToSlider(ms: number): number {
  return Math.round(
    (Math.log(ms) - Math.log(SPEED_MIN_MS)) /
    (Math.log(SPEED_MAX_MS) - Math.log(SPEED_MIN_MS)) * 100
  );
}
function sliderToSpeed(v: number): number {
  return Math.round(
    Math.exp(Math.log(SPEED_MIN_MS) + (v / 100) * (Math.log(SPEED_MAX_MS) - Math.log(SPEED_MIN_MS)))
  );
}
function fmtSpeed(ms: number): string {
  const min = ms / 60_000;
  if (min < 60) return `${Math.round(min)}m/s`;
  const hr = ms / 3_600_000;
  if (hr  < 24) return `${Math.round(hr)}h/s`;
  return `${Math.round(ms / 86_400_000)}d/s`;
}

// ── Date helpers ──

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fmtDateFull(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Range presets ──

const RANGE_PRESETS: { label: string; ms: number | null }[] = [
  { label: "7d",  ms: 7  * 86_400_000 },
  { label: "30d", ms: 30 * 86_400_000 },
  { label: "90d", ms: 90 * 86_400_000 },
  { label: "all", ms: null },
];

// ── Timeline: range handles + playhead + play + speed ──
// Layout: [▶] [start────playhead────end range slider] [speed slider] [7d 30d 90d all]
// The range slider has two handles (start/end). The playhead is a read-only indicator
// on the track. During play, playhead moves from rangeStart toward rangeEnd.

function TraceTimeline({
  dataMin, dataMax,
  rangeStart, rangeEnd, playheadMs,
  playing, playSpeed,
  visibleCount, totalCount,
  onRangeStart, onRangeEnd, onPlayhead,
  onTogglePlay, onSpeed, onPreset,
  activePreset,
}: {
  dataMin:      number;
  dataMax:      number;
  rangeStart:   number;
  rangeEnd:     number;
  playheadMs:   number;
  playing:      boolean;
  playSpeed:    number;
  visibleCount: number;
  totalCount:   number;
  onRangeStart: (v: number) => void;
  onRangeEnd:   (v: number) => void;
  onPlayhead:   (v: number) => void;
  onTogglePlay: () => void;
  onSpeed:      (v: number) => void;
  onPreset:     (ms: number | null) => void;
  activePreset: number | null;
}) {
  const span    = dataMax - dataMin || 1;
  const startPct = ((rangeStart  - dataMin) / span) * 100;
  const endPct   = ((rangeEnd    - dataMin) / span) * 100;
  const headPct  = ((playheadMs  - dataMin) / span) * 100;
  const atEnd    = playheadMs >= rangeEnd;

  return (
    <div className="trace-timeline">
      <div className="trace-timeline-inner">

        {/* Play / Pause / Replay */}
        <button
          className={`trace-tl-play${playing ? " playing" : ""}${atEnd && !playing ? " at-end" : ""}`}
          onClick={() => {
            if (atEnd && !playing) { onPlayhead(rangeStart); }
            onTogglePlay();
          }}
        >
          {playing ? "⏸" : atEnd ? "↺" : "▶"}
        </button>

        {/* Range slider + playhead indicator */}
        <div className="trace-tl-slider-wrap">
          {/* Date labels */}
          <div className="trace-tl-dates">
            <span>{fmtDateFull(rangeStart)}</span>
            <span className="trace-tl-now">{fmtDateFull(playheadMs)}</span>
            <span>{fmtDateFull(rangeEnd)}</span>
          </div>

          {/* Track with fills and playhead marker */}
          <div className="trace-tl-track-wrap">
            <div className="trace-tl-track">
              {/* Range window highlight */}
              <div className="trace-tl-range-fill" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />
              {/* Played-through fill */}
              <div className="trace-tl-played-fill" style={{ left: `${startPct}%`, width: `${Math.max(0, headPct - startPct)}%` }} />
            </div>

            {/* Playhead tick */}
            <div className="trace-tl-head" style={{ left: `${headPct}%` }} />

            {/* Range start handle */}
            <input
              type="range"
              className="trace-tl-input trace-tl-input-start"
              min={dataMin}
              max={dataMax}
              step={(dataMax - dataMin) / 2000}
              value={rangeStart}
              onChange={e => {
                const v = Number(e.target.value);
                onRangeStart(Math.min(v, rangeEnd - (dataMax - dataMin) / 200));
              }}
            />
            {/* Range end handle */}
            <input
              type="range"
              className="trace-tl-input trace-tl-input-end"
              min={dataMin}
              max={dataMax}
              step={(dataMax - dataMin) / 2000}
              value={rangeEnd}
              onChange={e => {
                const v = Number(e.target.value);
                onRangeEnd(Math.max(v, rangeStart + (dataMax - dataMin) / 200));
              }}
            />
          </div>
        </div>

        {/* Speed slider */}
        <div className="trace-tl-speed-wrap">
          <span className="trace-tl-speed-label">{fmtSpeed(playSpeed)}</span>
          <div className="trace-tl-track-wrap">
            <div className="trace-tl-track">
              <div className="trace-tl-played-fill" style={{ width: `${speedToSlider(playSpeed)}%` }} />
            </div>
            <input
              type="range"
              className="trace-tl-input"
              min={0}
              max={100}
              step={1}
              value={speedToSlider(playSpeed)}
              onChange={e => onSpeed(sliderToSpeed(Number(e.target.value)))}
            />
          </div>
        </div>

        {/* Range presets */}
        <div className="trace-tl-presets">
          {RANGE_PRESETS.map(({ label, ms }) => (
            <button
              key={label}
              className={`trace-tl-preset${activePreset === ms ? " active" : ""}`}
              onClick={() => onPreset(ms)}
            >{label}</button>
          ))}
        </div>

        {/* Count */}
        <span className="trace-tl-count">{visibleCount}<span className="trace-tl-count-sep">/</span>{totalCount}</span>

      </div>
    </div>
  );
}

// ── Info panel ──

function TraceInfoPanel({ particle, graph, onClose }: {
  particle: TraceParticle;
  graph:    TraceGraph;
  onClose:  () => void;
}) {
  if (particle.kind === "session") {
    const sess     = particle.data as SessionNode;
    const edges    = graph.edges.filter(e => e.sessionId === sess.sessionId).sort((a, b) => b.count - a.count);
    const topFiles = edges.slice(0, 10).map(e => graph.files.find(f => f.filePath === e.filePath)).filter(Boolean) as FileNode[];
    return (
      <div className="trace-detail">
        <div className="trace-detail-header">
          <span className="trace-detail-type">session</span>
          <button className="trace-detail-close" onClick={onClose}>×</button>
        </div>
        <div className="trace-detail-id">
          {sess.shortId}<span className="trace-detail-id-rest">{sess.sessionId.slice(8)}</span>
        </div>
        <div className="trace-detail-meta">
          {sess.provider && (
            <><span className="trace-detail-provider">{sess.provider}</span><span className="trace-detail-sep">·</span></>
          )}
          <span>{fmtDate(sess.firstSeen)} – {fmtDate(sess.lastSeen)}</span>
        </div>
        <div className="trace-detail-stat">{sess.files.length} files · {sess.touchCount} touches</div>
        {topFiles.length > 0 && (
          <div className="trace-detail-list">
            {topFiles.map(f => (
              <div key={f.filePath} className="trace-detail-item">
                <span style={{
                  display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                  background: f.fileKind === "code" ? "var(--info)" : "var(--warning)",
                  marginRight: 6, flexShrink: 0, verticalAlign: "middle",
                }} />
                {f.basename}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const file       = particle.data as FileNode;
  const edges      = graph.edges.filter(e => e.filePath === file.filePath).sort((a, b) => b.count - a.count);
  const topSessions = edges.slice(0, 8).map(e => graph.sessions.find(s => s.sessionId === e.sessionId)).filter(Boolean) as SessionNode[];
  return (
    <div className="trace-detail">
      <div className="trace-detail-header">
        <span className="trace-detail-type">file</span>
        <button className="trace-detail-close" onClick={onClose}>×</button>
      </div>
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
              <span style={{
                display: "inline-block", width: 5, height: 5, borderRadius: "50%",
                background: providerColor(s.provider), marginRight: 6, flexShrink: 0, verticalAlign: "middle",
              }} />
              {s.shortId}
              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 9 }}>{fmtDate(s.lastSeen)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main ──

export function TraceView() {
  const [touches,    setTouches]    = useState<TouchRecord[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [activeOps,  setActiveOps]  = useState<Set<string>>(new Set(["write", "edit"]));
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const [lockedId,   setLockedId]   = useState<string | null>(null);

  // ── Timeline state ──
  const [rangeStart,   setRangeStart]   = useState(0);
  const [rangeEnd,     setRangeEnd]     = useState(0);
  const [playheadMs,   setPlayheadMs]   = useState(0);
  const [playing,      setPlaying]      = useState(false);
  const [playSpeed,    setPlaySpeed]    = useState(sliderToSpeed(30));
  const [activePreset, setActivePreset] = useState<number | null>(null);

  // Ref so rAF loop reads current playhead without stale closure
  const playheadRef  = useRef(0);
  playheadRef.current = playheadMs;
  const rangeEndRef  = useRef(0);
  rangeEndRef.current = rangeEnd;

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<TraceParticle[]>([]);
  const graphRef     = useRef<TraceGraph>({ sessions: [], files: [], edges: [] });
  const cameraRef    = useRef({ ...INITIAL_CAMERA });
  const dragRef      = useRef({ dragging: false, button: 0, lastX: 0, lastY: 0 });
  const frameRef     = useRef(0);

  const hovIdxRef   = useRef(-1);
  const lockedIdRef = useRef<string | null>(null);
  hovIdxRef.current   = hoveredIdx;
  lockedIdRef.current = lockedId;

  const normTs = useCallback((ts: number) => ts < 1e12 ? ts * 1000 : ts, []);

  // ── Fetch all touches (always full dataset) ──
  const fetchKey = [...activeOps].sort().join(",");
  useEffect(() => {
    setLoading(true);
    fetchTouches({ ops: [...activeOps] })
      .then(r => { setTouches(r.touches); setError(null); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [fetchKey]); // eslint-disable-line

  // ── Data timestamp range ──
  const { dataMin, dataMax } = useMemo(() => {
    if (touches.length === 0) return { dataMin: 0, dataMax: Date.now() };
    let min = Infinity, max = -Infinity;
    for (const t of touches) {
      const ts = normTs(t.timestamp);
      if (ts < min) min = ts;
      if (ts > max) max = ts;
    }
    return { dataMin: min, dataMax: max };
  }, [touches, normTs]);

  // ── Init range and playhead when data loads ──
  useEffect(() => {
    if (dataMax > 0) {
      setRangeStart(dataMin);
      setRangeEnd(dataMax);
      setPlayheadMs(dataMax);
      setActivePreset(null);
    }
  }, [dataMin, dataMax]);

  // ── Preset handler: sets range span ending at dataMax ──
  function applyPreset(ms: number | null) {
    setActivePreset(ms);
    if (ms === null) {
      setRangeStart(dataMin);
      setRangeEnd(dataMax);
      setPlayheadMs(dataMax);
    } else {
      const start = Math.max(dataMin, dataMax - ms);
      setRangeStart(start);
      setRangeEnd(dataMax);
      setPlayheadMs(dataMax);
    }
    setPlaying(false);
  }

  // ── Range graph: all touches within [rangeStart, rangeEnd] ──
  // Session positions are computed from this — they span the full selected range and never move.
  const rangeTouches = useMemo(
    () => touches.filter(t => { const ts = normTs(t.timestamp); return ts >= rangeStart && ts <= rangeEnd; }),
    [touches, rangeStart, rangeEnd, normTs]
  );
  const rangeGraph = useMemo(() => buildGraph(rangeTouches), [rangeTouches]);

  // Session targets: fixed by timestamp position within [rangeStart, rangeEnd]
  const sessionTargets = useMemo(
    () => computeSessionTargets(rangeGraph.sessions, rangeStart, rangeEnd),
    [rangeGraph.sessions, rangeStart, rangeEnd]
  );

  // ── Visible graph: touches from rangeStart up to playhead ──
  // File positions are computed from this — they drift as more sessions are revealed.
  const visibleTouches = useMemo(
    () => touches.filter(t => { const ts = normTs(t.timestamp); return ts >= rangeStart && ts <= playheadMs; }),
    [touches, rangeStart, playheadMs, normTs]
  );
  const visibleGraph = useMemo(() => buildGraph(visibleTouches), [visibleTouches]);

  // File targets: centroid of currently active (visible) session positions
  const fileTargets = useMemo(
    () => computeFileTargets(visibleGraph.files, visibleGraph.edges, sessionTargets),
    [visibleGraph.files, visibleGraph.edges, sessionTargets]
  );

  // Keep graphRef pointing to visibleGraph for the render loop (edges, dimming)
  graphRef.current = visibleGraph;

  // ── rAF playback — advances playhead within range ──
  useEffect(() => {
    if (!playing) return;
    let raf: number;
    let lastTime = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTime;
      lastTime = now;
      setPlayheadMs(prev => {
        const next = prev + playSpeed * (dt / 1000);
        if (next >= rangeEndRef.current) {
          setPlaying(false);
          return rangeEndRef.current;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, playSpeed]);

  // ── Particle reconciliation ──
  // Sessions: populated from rangeGraph (all in range), positioned by date, revealed by playhead.
  // Files:    populated from visibleGraph (active only), positioned by live session centroids.
  const visibleSessionIds = useMemo(
    () => new Set(visibleGraph.sessions.map(s => s.sessionId)),
    [visibleGraph.sessions]
  );
  const visibleSessionIdsRef = useRef(visibleSessionIds);
  visibleSessionIdsRef.current = visibleSessionIds;

  useEffect(() => {
    const prev  = new Map(particlesRef.current.map(p => [p.id, p]));
    const next: TraceParticle[] = [];
    const frame = frameRef.current;

    // ── Sessions: all in range, fixed positions ──
    for (const sess of rangeGraph.sessions) {
      const id  = "s:" + sess.sessionId;
      const tgt = sessionTargets.get(id);
      if (!tgt) continue;
      const revealed = visibleSessionIdsRef.current.has(sess.sessionId);
      const p = prev.get(id);
      if (p) {
        // Position never changes — do NOT update target from visibleGraph
        p.data = sess;
        // Flip visibility as playhead crosses or retreats past firstSeen
        if (revealed && p.visibleSince < 0) p.visibleSince = frame;
        if (!revealed) p.visibleSince = -1;
        next.push(p);
      } else {
        next.push({
          id, kind: "session",
          pos:    { x: tgt.x, y: tgt.y, z: tgt.z },
          vel:    { x: 0, y: 0, z: 0 },
          target: tgt,
          color:  providerColor(sess.provider),
          age: 0,
          visibleSince: revealed ? frame : -1,
          data: sess,
        });
      }
    }

    // ── Files: only active ones, positions driven by visible session centroids ──
    for (const file of visibleGraph.files) {
      const id  = "f:" + file.filePath;
      const tgt = fileTargets.get(id);
      if (!tgt) continue;
      const p = prev.get(id);
      if (p) {
        // Update target so file drifts to new centroid as more sessions appear
        p.target = tgt; p.data = file; next.push(p);
      } else {
        next.push({
          id, kind: "file",
          pos:    { x: tgt.x, y: tgt.y, z: tgt.z },
          vel:    { x: 0, y: 0, z: 0 },
          target: tgt,
          color:  fileColor(file.fileKind),
          age: 0, visibleSince: frameRef.current,
          data: file,
        });
      }
    }

    particlesRef.current = next;
  }, [rangeGraph, sessionTargets, visibleGraph, fileTargets, visibleSessionIds]); // eslint-disable-line

  // ── Render + physics loop ──
  const renderAndStep = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.clientWidth;
    const h   = canvas.clientHeight;
    canvas.width  = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const cam       = cameraRef.current;
    const particles = particlesRef.current;
    const g         = graphRef.current;
    const frame     = frameRef.current++;

    // ── Physics ──
    for (const p of particles) {
      p.vel.x += (p.target.x - p.pos.x) * SPRING; p.vel.x *= DAMPING; p.pos.x += p.vel.x;
      p.vel.y += (p.target.y - p.pos.y) * SPRING; p.vel.y *= DAMPING; p.pos.y += p.vel.y;
      p.vel.z += (p.target.z - p.pos.z) * SPRING; p.vel.z *= DAMPING; p.pos.z += p.vel.z;
      p.age++;
    }

    // ── Transform ──
    type Proj = { sx: number; sy: number; scale: number; z: number; particle: TraceParticle; idx: number };
    const xfm: Proj[] = particles.map((p, idx) => {
      let v = rotateY(p.pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const pr = project(v, w, h, cam.camZ);
      return { sx: pr.sx + cam.panX, sy: pr.sy + cam.panY, scale: pr.scale, z: v.z, particle: p, idx };
    });
    xfm.sort((a, b) => b.z - a.z);

    const projMap = new Map<string, Proj>();
    for (const t of xfm) projMap.set(t.particle.id, t);

    // ── Clear ──
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // ── Connected set ──
    const hovIdx   = hovIdxRef.current;
    const locId    = lockedIdRef.current;
    const activeId = locId ?? (hovIdx >= 0 && hovIdx < particles.length ? particles[hovIdx].id : null);
    let connectedIds: Set<string> | null = null;
    if (activeId) {
      connectedIds = new Set([activeId]);
      if (activeId.startsWith("s:")) {
        const sid = activeId.slice(2);
        for (const e of g.edges) if (e.sessionId === sid) connectedIds.add("f:" + e.filePath);
      } else {
        const fp = activeId.slice(2);
        for (const e of g.edges) if (e.filePath === fp) connectedIds.add("s:" + e.sessionId);
      }
    }

    // ── Edges (only between revealed sessions and active files) ──
    type EdgeEntry = { a: Proj; b: Proj; op: string; opacity: number; count: number; avgZ: number; entrance: number };
    const edgeList: EdgeEntry[] = [];
    for (const e of g.edges) {
      const a = projMap.get("s:" + e.sessionId);
      const b = projMap.get("f:" + e.filePath);
      if (!a || !b) continue;
      if (a.particle.visibleSince < 0) continue; // session not yet revealed
      const eA = Math.min(1, (frame - a.particle.visibleSince) / ENTRANCE_FRAMES);
      const eB = Math.min(1, (frame - b.particle.visibleSince) / ENTRANCE_FRAMES);
      edgeList.push({ a, b, op: e.dominantOp, opacity: e.opacity, count: e.count, avgZ: (a.z + b.z) / 2, entrance: eA * eB });
    }
    edgeList.sort((a, b) => b.avgZ - a.avgZ);

    for (const { a, b, op, opacity, count, entrance } of edgeList) {
      const connected = connectedIds ? connectedIds.has(a.particle.id) && connectedIds.has(b.particle.id) : false;
      let alpha = opacity * entrance;
      if (connectedIds) alpha = connected ? Math.min(0.85, opacity * 2.4) * entrance : 0.025 * entrance;
      const color    = (op === "write" || op === "edit") ? "#33cc33" : op === "read" ? "#5090ff" : "#444444";
      const avgScale = (a.scale + b.scale) / 2;
      const dy       = b.sy - a.sy;
      ctx.save();
      ctx.globalAlpha = alpha * avgScale;
      ctx.strokeStyle = color;
      ctx.lineWidth   = (0.5 + Math.min(count / 5, 1.5)) * avgScale;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.bezierCurveTo(a.sx, a.sy + dy * 0.45, b.sx, b.sy - dy * 0.35, b.sx, b.sy);
      ctx.stroke();
      ctx.restore();
    }

    // ── Dir labels ──
    const dirs = new Map<string, { x: number; y: number; n: number; sc: number }>();
    for (const t of xfm) {
      if (t.particle.kind !== "file") continue;
      const dir = (t.particle.data as FileNode).dir;
      const d   = dirs.get(dir);
      if (d) { d.x += t.sx; d.y += t.sy; d.n++; d.sc += t.scale; }
      else dirs.set(dir, { x: t.sx, y: t.sy, n: 1, sc: t.scale });
    }
    ctx.save();
    ctx.textAlign = "center";
    for (const [dir, d] of dirs) {
      const sc = d.sc / d.n;
      ctx.globalAlpha = 0.15 * sc;
      ctx.font = `${Math.round(9 * Math.max(1, sc))}px 'JetBrains Mono', monospace`;
      ctx.fillStyle = "#666666";
      ctx.fillText(dir.toUpperCase(), d.x / d.n, d.y / d.n - 24 * sc);
    }
    ctx.restore();

    // ── Particles: glow + dot ──
    for (const { sx, sy, scale, particle, idx } of xfm) {
      if (particle.visibleSince < 0) continue; // hidden session (not yet revealed by playhead)
      const t        = Math.min(1, (frame - particle.visibleSince) / ENTRANCE_FRAMES);
      const entrance = t * t * (3 - 2 * t); // smoothstep
      const isActive = idx === hovIdx || locId === particle.id;
      const dimmed   = connectedIds ? !connectedIds.has(particle.id) : false;
      const isSess   = particle.kind === "session";
      const baseR    = isSess ? 5 : 3.5;
      const r        = (isActive ? baseR * 1.6 : baseR) * scale * entrance;
      if (r < 0.3) continue;

      const alpha = dimmed ? 0.1 * entrance : Math.max(0.22, Math.min(1, scale * 1.2)) * entrance;
      const glowR = r * (isSess ? 5.5 : 4);

      ctx.save();
      ctx.globalAlpha = alpha * (isActive ? 0.52 : 0.18);
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
      gr.addColorStop(0, particle.color);
      gr.addColorStop(1, "transparent");
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(sx, sy, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      if (isActive) {
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9 * entrance;
        ctx.beginPath(); ctx.arc(sx, sy, r + 3 * scale, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    // ── Labels (active only) ──
    for (const { sx, sy, scale, particle, idx } of xfm) {
      if (idx !== hovIdx && locId !== particle.id) continue;
      const isSess = particle.kind === "session";
      const label  = isSess ? (particle.data as SessionNode).shortId : (particle.data as FileNode).basename;
      const yOff   = (isSess ? -9 : -6) * scale - 12;
      ctx.save();
      ctx.globalAlpha = 0.96;
      ctx.font = `${Math.max(9, Math.round(11 * scale))}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.88)";
      ctx.fillRect(sx - tw / 2 - 5, sy + yOff - 13, tw + 10, 16);
      ctx.fillStyle = "#e0e0e0";
      ctx.fillText(label, sx, sy + yOff);
      ctx.restore();
    }
  }, []);

  // ── Animation loop ──
  useEffect(() => {
    let raf: number;
    const loop = () => {
      if (cameraRef.current.autoRotate && !dragRef.current.dragging) cameraRef.current.rotY += 0.0012;
      renderAndStep();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [renderAndStep]);

  // ── Wheel zoom ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cameraRef.current.camZ -= e.deltaY * 1.15;
      cameraRef.current.camZ = Math.max(MIN_CAM_Z, Math.min(MAX_CAM_Z, cameraRef.current.camZ));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── Mouse ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { dragging: true, button: e.button, lastX: e.clientX, lastY: e.clientY };
    cameraRef.current.autoRotate = false;
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      if (dragRef.current.button === 2) {
        cameraRef.current.panX += dx;
        cameraRef.current.panY += dy;
      } else {
        cameraRef.current.rotY += dx * 0.005;
        cameraRef.current.rotX += dy * 0.005;
        cameraRef.current.rotX = Math.max(-1.2, Math.min(1.2, cameraRef.current.rotX));
      }
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const cam = cameraRef.current;
    const particles = particlesRef.current;
    let closest = -1, closestDist = 22;
    for (let i = 0; i < particles.length; i++) {
      if (particles[i].visibleSince < 0) continue;
      let v = rotateY(particles[i].pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const p = project(v, canvas.clientWidth, canvas.clientHeight, cam.camZ);
      const d = Math.hypot(p.sx + cam.panX - mx, p.sy + cam.panY - my);
      if (d < closestDist) { closestDist = d; closest = i; }
    }
    setHoveredIdx(closest);
    canvas.style.cursor = closest >= 0 ? "pointer" : "grab";
  }, []);

  const handleMouseUp   = useCallback(() => { dragRef.current.dragging = false; }, []);
  const handleClick     = useCallback(() => {
    const particles = particlesRef.current;
    if (hoveredIdx >= 0 && hoveredIdx < particles.length) {
      const pid = particles[hoveredIdx].id;
      setLockedId(id => id === pid ? null : pid);
    } else {
      setLockedId(null);
    }
  }, [hoveredIdx]);

  function toggleOp(op: string) {
    setActiveOps(prev => {
      const next = new Set(prev);
      if (next.has(op)) { if (next.size > 1) next.delete(op); } else next.add(op);
      return next;
    });
  }

  const panelParticle = lockedId ? particlesRef.current.find(p => p.id === lockedId) ?? null : null;
  const showTimeline  = !loading && !error && dataMin > 0;

  return (
    <div className="trace-panel">

      <div className="trace-toolbar">
        <div className="trace-toolbar-left">
          <span className="trace-toolbar-label">ops</span>
          {OP_OPTIONS.map(({ key, label }) => (
            <button
              key={key}
              className={`trace-op-pill trace-op-pill--${key}${activeOps.has(key) ? " active" : ""}`}
              onClick={() => toggleOp(key)}
            >{label}</button>
          ))}
        </div>
        <div className="trace-toolbar-right">
          {!loading && !error && visibleGraph.sessions.length > 0 && (
            <span className="trace-stats">
              {visibleGraph.sessions.length} sessions · {visibleGraph.files.length} files · {visibleGraph.edges.length} edges
            </span>
          )}
          {loading && <span className="trace-loading">loading…</span>}
          {error   && <span className="trace-error">{error}</span>}
        </div>
      </div>

      <div className="trace-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="trace-canvas"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onContextMenu={handleContextMenu}
          onClick={handleClick}
        />

        <button className="trace-reset-btn" onClick={() => Object.assign(cameraRef.current, INITIAL_CAMERA)}>⌖</button>

        {panelParticle && (
          <TraceInfoPanel particle={panelParticle} graph={visibleGraph} onClose={() => setLockedId(null)} />
        )}

        {showTimeline && (
          <TraceTimeline
            dataMin={dataMin}
            dataMax={dataMax}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            playheadMs={playheadMs}
            playing={playing}
            playSpeed={playSpeed}
            visibleCount={visibleTouches.length}
            totalCount={touches.length}
            onRangeStart={v => { setRangeStart(v); if (playheadMs < v) setPlayheadMs(v); setActivePreset(null); setPlaying(false); }}
            onRangeEnd={v   => { setRangeEnd(v);   if (playheadMs > v) setPlayheadMs(v); setActivePreset(null); setPlaying(false); }}
            onPlayhead={v   => { setPlayheadMs(v); setPlaying(false); }}
            onTogglePlay={() => setPlaying(p => !p)}
            onSpeed={setPlaySpeed}
            onPreset={applyPreset}
            activePreset={activePreset}
          />
        )}

        <div className="trace-controls-hint">
          drag to rotate · right-drag to pan · scroll to zoom · click to lock
        </div>

        {!loading && !error && touches.length === 0 && (
          <div className="trace-empty">no touch data for selected filters</div>
        )}
      </div>
    </div>
  );
}
