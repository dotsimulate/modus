import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { fetchTouches, type TouchRecord, type TouchQuery } from "../api/trace";
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
  id:     string;           // "s:{sessionId}" or "f:{filePath}"
  kind:   "session" | "file";
  pos:    Vec3;
  vel:    Vec3;
  target: Vec3;
  color:  string;
  age:    number;
  data:   SessionNode | FileNode;
};

const SPRING  = 0.038;
const DAMPING = 0.84;

// ── Colors (canvas — no CSS vars) ──

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

function computeTargets(graph: TraceGraph): Map<string, Vec3> {
  const result  = new Map<string, Vec3>();
  const sessPos = new Map<string, Vec3>();
  const n = graph.sessions.length;

  // Sessions: temporal ribbon — oldest=far(Z=280), newest=close(Z=0), spread in X
  graph.sessions.forEach((sess, i) => {
    const t   = n <= 1 ? 0.5 : i / (n - 1);
    const pos = { x: (t - 0.5) * 620, y: 70, z: (1 - t) * 280 };
    sessPos.set(sess.sessionId, pos);
    result.set("s:" + sess.sessionId, pos);
  });

  // Files: centroid of connected session positions + per-file seeded jitter
  for (const file of graph.files) {
    let cx = 0, cz = 0, cnt = 0;
    for (const e of graph.edges) {
      if (e.filePath !== file.filePath) continue;
      const sp = sessPos.get(e.sessionId);
      if (sp) { cx += sp.x; cz += sp.z; cnt++; }
    }
    if (cnt > 0) { cx /= cnt; cz /= cnt; }

    const seed = file.filePath.split("").reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 17);
    const rng  = seededRandom(seed);
    result.set("f:" + file.filePath, {
      x: cx + (rng() - 0.5) * 160,
      y: -55 + (rng() - 0.5) * 55,
      z: cz  + (rng() - 0.5) * 160,
    });
  }

  return result;
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

function fmtDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  const [touches, setTouches]     = useState<TouchRecord[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [activeOps, setActiveOps] = useState<Set<string>>(new Set(["write", "edit"]));
  const [timeMs, setTimeMs]       = useState<number | null>(30 * 86_400_000);
  const [hoveredIdx, setHoveredIdx] = useState(-1);
  const [lockedId, setLockedId]     = useState<string | null>(null);

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<TraceParticle[]>([]);
  const graphRef     = useRef<TraceGraph>({ sessions: [], files: [], edges: [] });
  const cameraRef    = useRef({ rotY: 0.3, rotX: -0.15, camZ: -125, panX: 0, panY: 0, autoRotate: true });
  const dragRef      = useRef({ dragging: false, button: 0, lastX: 0, lastY: 0 });

  // Stable refs for rAF loop
  const hovIdxRef   = useRef(-1);
  const lockedIdRef = useRef<string | null>(null);
  hovIdxRef.current   = hoveredIdx;
  lockedIdRef.current = lockedId;

  // ── Fetch ──
  const fetchKey = `${[...activeOps].sort().join(",")}|${timeMs}`;
  useEffect(() => {
    setLoading(true);
    const q: TouchQuery = { limit: 3000, ops: [...activeOps] };
    if (timeMs) q.from = Date.now() - timeMs;
    fetchTouches(q)
      .then(r => { setTouches(r.touches); setError(null); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [fetchKey]); // eslint-disable-line

  const graph   = useMemo(() => buildGraph(touches), [touches]);
  const targets = useMemo(() => computeTargets(graph), [graph]);
  graphRef.current = graph;

  // ── Particle reconciliation ──
  useEffect(() => {
    const prev = new Map(particlesRef.current.map(p => [p.id, p]));
    const next: TraceParticle[] = [];

    for (const sess of graph.sessions) {
      const id  = "s:" + sess.sessionId;
      const tgt = targets.get(id);
      if (!tgt) continue;
      const p = prev.get(id);
      if (p) {
        p.target = tgt; p.data = sess; next.push(p);
      } else {
        const rng = seededRandom(sess.sessionId.charCodeAt(0) * 31 + sess.sessionId.length);
        next.push({
          id, kind: "session",
          pos: { x: (rng() - 0.5) * 40, y: (rng() - 0.5) * 40, z: (rng() - 0.5) * 40 },
          vel: { x: 0, y: 0, z: 0 }, target: tgt,
          color: providerColor(sess.provider), age: 0, data: sess,
        });
      }
    }

    for (const file of graph.files) {
      const id  = "f:" + file.filePath;
      const tgt = targets.get(id);
      if (!tgt) continue;
      const p = prev.get(id);
      if (p) {
        p.target = tgt; p.data = file; next.push(p);
      } else {
        const rng = seededRandom(file.filePath.charCodeAt(0) * 17 + file.filePath.length);
        next.push({
          id, kind: "file",
          pos: { x: (rng() - 0.5) * 40, y: (rng() - 0.5) * 40, z: (rng() - 0.5) * 40 },
          vel: { x: 0, y: 0, z: 0 }, target: tgt,
          color: fileColor(file.fileKind), age: 0, data: file,
        });
      }
    }

    particlesRef.current = next;
  }, [graph, targets]);

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

    // ID → projected position lookup for edge drawing
    const projMap = new Map<string, Proj>();
    for (const t of xfm) projMap.set(t.particle.id, t);

    // ── Clear ──
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // ── Connected set (for dimming) ──
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

    // ── Edges ──
    type EdgeEntry = { a: Proj; b: Proj; op: string; opacity: number; count: number; avgZ: number };
    const edgeList: EdgeEntry[] = [];
    for (const e of g.edges) {
      const a = projMap.get("s:" + e.sessionId);
      const b = projMap.get("f:" + e.filePath);
      if (!a || !b) continue;
      edgeList.push({ a, b, op: e.dominantOp, opacity: e.opacity, count: e.count, avgZ: (a.z + b.z) / 2 });
    }
    edgeList.sort((a, b) => b.avgZ - a.avgZ);

    for (const { a, b, op, opacity, count } of edgeList) {
      const connected = connectedIds
        ? connectedIds.has(a.particle.id) && connectedIds.has(b.particle.id)
        : false;
      let alpha = opacity;
      if (connectedIds) alpha = connected ? Math.min(0.85, opacity * 2.4) : 0.025;

      const color = (op === "write" || op === "edit") ? "#33cc33" : op === "read" ? "#5090ff" : "#444444";
      const avgScale = (a.scale + b.scale) / 2;
      const dy = b.sy - a.sy;

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

    // ── Directory labels (centroid of file particles per dir) ──
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

    // ── Particles pass 1: glow + core dot ──
    for (const { sx, sy, scale, particle, idx } of xfm) {
      const isActive = idx === hovIdx || locId === particle.id;
      const dimmed   = connectedIds ? !connectedIds.has(particle.id) : false;
      const entrance = Math.min(1, particle.age / 20);
      const ns       = scale * entrance;
      const isSess   = particle.kind === "session";
      const baseR    = isSess ? 5 : 3.5;
      const r        = (isActive ? baseR * 1.6 : baseR) * ns;
      if (r < 0.3) continue;

      const alpha = dimmed ? 0.1 : Math.max(0.22, Math.min(1, ns * 1.2));
      const glowR  = r * (isSess ? 5.5 : 4);

      // Glow
      ctx.save();
      ctx.globalAlpha = alpha * (isActive ? 0.52 : 0.18);
      const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR);
      gr.addColorStop(0, particle.color);
      gr.addColorStop(1, "transparent");
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(sx, sy, glowR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // Core dot
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
      if (isActive) {
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(sx, sy, r + 3 * ns, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }

    // ── Particles pass 2: labels on active only ──
    for (const { sx, sy, scale, particle, idx } of xfm) {
      if (idx !== hovIdx && locId !== particle.id) continue;
      const isSess = particle.kind === "session";
      const label  = isSess
        ? (particle.data as SessionNode).shortId
        : (particle.data as FileNode).basename;
      const yOff = (isSess ? -9 : -6) * scale - 12;

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
      const cam = cameraRef.current;
      if (cam.autoRotate && !dragRef.current.dragging) cam.rotY += 0.0012;
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
      cameraRef.current.camZ -= e.deltaY * 0.8;
      cameraRef.current.camZ = Math.max(-1500, Math.min(100, cameraRef.current.camZ));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── Mouse handlers ──
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

    // Hit test
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cam = cameraRef.current;
    const particles = particlesRef.current;

    let closest = -1, closestDist = 22;
    for (let i = 0; i < particles.length; i++) {
      let v = rotateY(particles[i].pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const p = project(v, w, h, cam.camZ);
      const d = Math.hypot(p.sx + cam.panX - mx, p.sy + cam.panY - my);
      if (d < closestDist) { closestDist = d; closest = i; }
    }
    setHoveredIdx(closest);
    canvas.style.cursor = closest >= 0 ? "pointer" : "grab";
  }, []);

  const handleMouseUp = useCallback(() => { dragRef.current.dragging = false; }, []);

  const handleClick = useCallback(() => {
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
      if (next.has(op)) { if (next.size > 1) next.delete(op); }
      else next.add(op);
      return next;
    });
  }

  // Panel: show locked particle only (hover highlights in canvas)
  const panelParticle = lockedId
    ? particlesRef.current.find(p => p.id === lockedId) ?? null
    : null;

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
            >{label}</button>
          ))}
          <div className="trace-toolbar-sep" />
          {TIME_OPTIONS.map(({ label, ms }) => (
            <button
              key={label}
              className={`trace-time-pill${timeMs === ms ? " active" : ""}`}
              onClick={() => setTimeMs(ms)}
            >{label}</button>
          ))}
        </div>
        <div className="trace-toolbar-right">
          {!loading && !error && graph.sessions.length > 0 && (
            <span className="trace-stats">
              {graph.sessions.length} sessions · {graph.files.length} files · {graph.edges.length} edges
            </span>
          )}
          {loading && <span className="trace-loading">loading…</span>}
          {error   && <span className="trace-error">{error}</span>}
        </div>
      </div>

      {/* ── Canvas ── */}
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

        {/* Reset view */}
        <button
          className="trace-reset-btn"
          onClick={() => {
            const cam = cameraRef.current;
            cam.rotY = 0.3; cam.rotX = -0.15; cam.camZ = -125; cam.panX = 0; cam.panY = 0;
            cam.autoRotate = true;
          }}
        >⌖</button>

        {/* Detail panel */}
        {panelParticle && (
          <TraceInfoPanel
            particle={panelParticle}
            graph={graph}
            onClose={() => setLockedId(null)}
          />
        )}

        {/* Hint */}
        <div className="trace-controls-hint">
          drag to rotate · right-drag to pan · scroll to zoom · click to lock
        </div>

        {/* Empty state */}
        {!loading && !error && graph.sessions.length === 0 && (
          <div className="trace-empty">no touch data for selected filters</div>
        )}
      </div>
    </div>
  );
}
