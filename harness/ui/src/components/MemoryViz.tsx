import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { fetchMemories, type MemoryItem } from "../api";

// ── Type colors ──
const TYPE_COLORS: Record<string, string> = {
  correction: "#ff6b6b",
  discovery: "#4ecdc4",
  pattern: "#a29bfe",
  preference: "#ffd93d",
  reference: "#6c9bff",
  hazard: "#ff9f43",
};

const TYPE_ORDER = ["correction", "discovery", "pattern", "preference", "reference", "hazard"];

function typeColor(t: string): string {
  return TYPE_COLORS[t] ?? "#666";
}

// ── 3D Math ──
type Vec3 = { x: number; y: number; z: number };

function rotateY(v: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
}

function rotateX(v: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: v.x, y: v.y * cos - v.z * sin, z: v.y * sin + v.z * cos };
}

function project(v: Vec3, w: number, h: number, camZ: number): { sx: number; sy: number; scale: number } {
  const fov = 600;
  const z = v.z - camZ;
  const d = fov / (fov + z);
  return { sx: v.x * d + w / 2, sy: v.y * d + h / 2, scale: Math.max(0.1, d) };
}

// ── Physics particle ──
type Particle = {
  id: string;         // memory id — stable across filter changes
  pos: Vec3;          // current animated position
  vel: Vec3;          // velocity
  target: Vec3;       // where it wants to be
  color: string;
  mem: MemoryItem;
  age: number;        // frames since spawned (for entrance anim)
};

// ── Seeded random ──
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

// ── Compute target positions for a set of memories ──
function computeTargets(memories: MemoryItem[]): Map<string, { target: Vec3; color: string }> {
  const result = new Map<string, { target: Vec3; color: string }>();
  if (memories.length === 0) return result;

  const typeAngles: Record<string, number> = {};
  TYPE_ORDER.forEach((t, i) => {
    typeAngles[t] = (i / TYPE_ORDER.length) * Math.PI * 2;
  });

  const clusterRadius = 200;
  const nodeSpread = 100;
  const rng = seededRandom(42);
  const typeCounters: Record<string, number> = {};

  for (const m of memories) {
    const t = m.type || "discovery";
    const angle = typeAngles[t] ?? 0;
    typeCounters[t] = (typeCounters[t] || 0) + 1;
    const idx = typeCounters[t];

    const cx = Math.cos(angle) * clusterRadius;
    const cz = Math.sin(angle) * clusterRadius;

    const goldenAngle = 2.399963;
    const spiralAngle = idx * goldenAngle;
    const spiralR = Math.sqrt(idx) * (nodeSpread / Math.sqrt(20));

    const x = cx + Math.cos(spiralAngle) * spiralR;
    const z = cz + Math.sin(spiralAngle) * spiralR;

    const confMap: Record<string, number> = { high: -40, medium: 0, low: 40 };
    const baseY = confMap[m.confidence] ?? 0;
    const y = baseY + (rng() - 0.5) * 80;

    result.set(m.id, { target: { x, y, z }, color: typeColor(t) });
  }

  return result;
}

// Find tag connections between particles (by index in particles array)
function findConnections(particles: Particle[]): [number, number][] {
  const tagMap = new Map<string, number[]>();
  for (let i = 0; i < particles.length; i++) {
    for (const tag of particles[i].mem.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(i);
    }
  }
  const edges = new Set<string>();
  const result: [number, number][] = [];
  for (const [, indices] of tagMap) {
    if (indices.length < 2 || indices.length > 10) continue;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const key = `${indices[i]}-${indices[j]}`;
        if (!edges.has(key)) {
          edges.add(key);
          result.push([indices[i], indices[j]]);
        }
      }
    }
  }
  return result;
}

// ── Memory feed — scrollable hazy panel showing multiple memories ──
function MemoryCard({ mem, highlighted }: { mem: MemoryItem; highlighted: boolean }) {
  const [showTags, setShowTags] = useState(false);
  return (
    <div
      className={`memviz-card${highlighted ? " memviz-card-hl" : ""}`}
      onMouseEnter={() => setShowTags(true)}
      onMouseLeave={() => setShowTags(false)}
    >
      <div className="memviz-card-header">
        <span className="memviz-detail-dot" style={{ background: typeColor(mem.type) }} />
        <span className="memviz-detail-id">{mem.id}</span>
        <span className="memviz-card-meta">{mem.type}{mem.profile ? ` · ${mem.profile}` : ""} · {mem.created}</span>
      </div>
      <div className="memviz-card-body">{mem.body}</div>
      {showTags && mem.tags.length > 0 && (
        <div className="memviz-card-tags">
          {mem.tags.map((t) => <span key={t} className="memviz-tag">{t}</span>)}
        </div>
      )}
    </div>
  );
}

function MemoryFeed({
  memories, highlightId, onClose,
}: {
  memories: MemoryItem[]; highlightId: string | null; onClose: () => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);

  // Scroll to highlighted memory when it changes
  useEffect(() => {
    if (!highlightId || !feedRef.current) return;
    const el = feedRef.current.querySelector(`[data-mem-id="${highlightId}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [highlightId]);

  return (
    <div className="memviz-feed" onClick={(e) => e.stopPropagation()}>
      <div className="memviz-feed-header">
        <span className="memviz-feed-title">memories</span>
        <span className="memviz-feed-count">{memories.length}</span>
        <button className="memviz-detail-close" onClick={onClose}>&times;</button>
      </div>
      <div className="memviz-feed-scroll" ref={feedRef}>
        {memories.map((m) => (
          <div key={m.id} data-mem-id={m.id}>
            <MemoryCard mem={m} highlighted={m.id === highlightId} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Filter bar ──
function FilterBar({
  types, activeTypes, onToggle, search, onSearch,
  tagFilter, onTagFilter, allTags,
  profileFilter, onProfileFilter, allProfiles,
}: {
  types: string[]; activeTypes: Set<string>; onToggle: (t: string) => void;
  search: string; onSearch: (s: string) => void;
  tagFilter: string; onTagFilter: (t: string) => void; allTags: string[];
  profileFilter: string; onProfileFilter: (p: string) => void; allProfiles: string[];
}) {
  return (
    <div className="memviz-filters">
      <div className="memviz-type-filters">
        {types.map((t) => (
          <button
            key={t}
            className={`memviz-type-btn ${activeTypes.has(t) ? "active" : ""}`}
            style={{ "--type-color": typeColor(t) } as React.CSSProperties}
            onClick={() => onToggle(t)}
          >
            <span className="memviz-type-dot" style={{ background: typeColor(t) }} />
            {t}
          </button>
        ))}
      </div>
      <input
        className="memviz-search"
        placeholder="search memories..."
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <select className="memviz-tag-select" value={tagFilter} onChange={(e) => onTagFilter(e.target.value)}>
        <option value="">all tags</option>
        {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {allProfiles.length > 0 && (
        <select className="memviz-tag-select" value={profileFilter} onChange={(e) => onProfileFilter(e.target.value)}>
          <option value="">all profiles</option>
          {allProfiles.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
    </div>
  );
}

// ── Stats bar ──
function StatsBar({ memories }: { memories: MemoryItem[] }) {
  const typeCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};
  for (const m of memories) {
    typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
    for (const t of m.tags) tagCounts[t] = (tagCounts[t] || 0) + 1;
  }
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="memviz-stats">
      <span className="memviz-stat-total">{memories.length} memories</span>
      {TYPE_ORDER.filter((t) => typeCounts[t]).map((t) => (
        <span key={t} className="memviz-stat-type" style={{ color: typeColor(t) }}>
          {typeCounts[t]} {t}
        </span>
      ))}
      <span className="memviz-stat-sep">|</span>
      <span className="memviz-stat-label">top tags:</span>
      {topTags.map(([tag, count]) => (
        <span key={tag} className="memviz-stat-tag">{tag} ({count})</span>
      ))}
    </div>
  );
}

// ── Physics constants ──
const SPRING = 0.04;    // spring stiffness toward target
const DAMPING = 0.85;   // velocity damping (friction)
const SETTLE_AGE = 60;  // frames until "fully settled" for connection fade-in

// ── Main component ──
export function MemoryViz({ onBack }: { onBack: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [feedOpen, setFeedOpen] = useState(false);
  const [hovered, setHovered] = useState<number>(-1);

  // Filters
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(TYPE_ORDER));
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [profileFilter, setProfileFilter] = useState("");

  // Camera
  const cameraRef = useRef({ rotY: 0.4, rotX: -0.25, camZ: -500, autoRotate: true });
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0 });

  // Physics particles — mutable ref, updated every frame
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    fetchMemories()
      .then((m) => { setMemories(m); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const m of memories) for (const t of m.tags) tags.add(t);
    return Array.from(tags).sort();
  }, [memories]);

  const allProfiles = useMemo(() => {
    const profiles = new Set<string>();
    for (const m of memories) if (m.profile) profiles.add(m.profile);
    return Array.from(profiles).sort();
  }, [memories]);

  const filtered = useMemo(() => {
    return memories.filter((m) => {
      if (!activeTypes.has(m.type || "discovery")) return false;
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      if (profileFilter && m.profile !== profileFilter) return false;
      if (search) {
        const s = search.toLowerCase();
        return m.id.toLowerCase().includes(s)
          || m.body.toLowerCase().includes(s)
          || m.tags.some((t) => t.toLowerCase().includes(s));
      }
      return true;
    });
  }, [memories, activeTypes, search, tagFilter, profileFilter]);

  // When filtered set changes, reconcile particles: add new, remove old, update targets
  const targets = useMemo(() => computeTargets(filtered), [filtered]);

  useEffect(() => {
    const existing = new Map<string, Particle>();
    for (const p of particlesRef.current) existing.set(p.id, p);

    const next: Particle[] = [];
    for (const m of filtered) {
      const t = targets.get(m.id);
      if (!t) continue;

      const prev = existing.get(m.id);
      if (prev) {
        // Update target — particle keeps its current position and springs there
        prev.target = t.target;
        prev.color = t.color;
        prev.mem = m;
        next.push(prev);
      } else {
        // New particle — spawn from center with a slight random kick
        const rng = seededRandom(m.id.length * 31 + m.id.charCodeAt(0));
        next.push({
          id: m.id,
          pos: { x: (rng() - 0.5) * 30, y: (rng() - 0.5) * 30, z: (rng() - 0.5) * 30 },
          vel: { x: (rng() - 0.5) * 2, y: (rng() - 0.5) * 2, z: (rng() - 0.5) * 2 },
          target: t.target,
          color: t.color,
          mem: m,
          age: 0,
        });
      }
    }
    particlesRef.current = next;
  }, [filtered, targets]);

  // Connections are derived from current particles (recomputed each frame is fine for 60 nodes)
  // But we precompute the static set and just animate opacity based on particle age
  const connectionsRef = useRef<[number, number][]>([]);

  // Canvas rendering + physics step combined in the animation loop
  const hoveredRef = useRef(-1);
  const selectedRef = useRef<string | null>(null);
  hoveredRef.current = hovered;
  selectedRef.current = highlightId;

  const renderAndStep = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const cam = cameraRef.current;
    const particles = particlesRef.current;

    // ── Physics step ──
    for (const p of particles) {
      // Spring force toward target
      p.vel.x += (p.target.x - p.pos.x) * SPRING;
      p.vel.y += (p.target.y - p.pos.y) * SPRING;
      p.vel.z += (p.target.z - p.pos.z) * SPRING;

      // Damping
      p.vel.x *= DAMPING;
      p.vel.y *= DAMPING;
      p.vel.z *= DAMPING;

      // Integrate
      p.pos.x += p.vel.x;
      p.pos.y += p.vel.y;
      p.pos.z += p.vel.z;

      // Age
      p.age++;
    }

    // Recompute connections (cheap for <100 nodes)
    connectionsRef.current = findConnections(particles);
    const connections = connectionsRef.current;

    // ── Transform ──
    const transformed = particles.map((p, i) => {
      let v = rotateY(p.pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const proj = project(v, w, h, cam.camZ);
      return { ...proj, particle: p, idx: i, z: v.z };
    });
    transformed.sort((a, b) => b.z - a.z);

    // ── Clear ──
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, w, h);

    // ── Draw connections ──
    // Opacity grows as both connected particles settle
    ctx.save();
    for (const [i, j] of connections) {
      const a = particles[i], b = particles[j];
      const settleA = Math.min(1, a.age / SETTLE_AGE);
      const settleB = Math.min(1, b.age / SETTLE_AGE);
      const settle = settleA * settleB; // both must be settled

      let va = rotateY(a.pos, cam.rotY); va = rotateX(va, cam.rotX);
      let vb = rotateY(b.pos, cam.rotY); vb = rotateX(vb, cam.rotX);
      const pa = project(va, w, h, cam.camZ);
      const pb = project(vb, w, h, cam.camZ);
      const avgScale = (pa.scale + pb.scale) / 2;

      ctx.globalAlpha = Math.min(0.15, 0.1 * avgScale) * settle;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 0.5 + settle * 0.5;
      ctx.beginPath();
      ctx.moveTo(pa.sx, pa.sy);
      ctx.lineTo(pb.sx, pb.sy);
      ctx.stroke();
    }
    ctx.restore();

    // ── Type cluster labels ──
    ctx.save();
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.textAlign = "center";
    TYPE_ORDER.forEach((t, i) => {
      const angle = (i / TYPE_ORDER.length) * Math.PI * 2;
      const lx = Math.cos(angle) * 200;
      const lz = Math.sin(angle) * 200;
      let v: Vec3 = { x: lx, y: 80, z: lz };
      v = rotateY(v, cam.rotY);
      v = rotateX(v, cam.rotX);
      const p = project(v, w, h, cam.camZ);
      if (p.scale > 0.2) {
        ctx.fillStyle = typeColor(t);
        ctx.globalAlpha = 0.2 * p.scale;
        ctx.fillText(t, p.sx, p.sy);
      }
    });
    ctx.restore();

    // ── Draw particles (dots first, labels second so labels are always on top) ──
    const hovIdx = hoveredRef.current;
    const selId = selectedRef.current;

    // Pass 1: dots + glows
    for (const t of transformed) {
      const { sx, sy, scale, particle, idx } = t;
      const isHovered = idx === hovIdx;
      const isSelected = selId === particle.id;

      const entrance = Math.min(1, particle.age / 20);
      const nodeScale = scale * entrance;
      const radius = (isHovered || isSelected ? 7 : 4) * nodeScale;
      const alpha = Math.max(0.2, Math.min(1, nodeScale * 1.2));

      if (radius < 0.5) continue;

      // Glow
      ctx.save();
      ctx.globalAlpha = alpha * (isHovered || isSelected ? 0.5 : 0.2);
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, radius * 5);
      glow.addColorStop(0, particle.color);
      glow.addColorStop(1, "transparent");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(sx, sy, radius * 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Core dot
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = particle.color;
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();

      // White ring on hover/select
      if (isHovered || isSelected) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(sx, sy, radius + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Pass 2: labels (drawn last = always on top of all dots)
    for (const t of transformed) {
      const { sx, sy, scale, particle, idx } = t;
      const isHovered = idx === hovIdx;
      const isSelected = selId === particle.id;

      if (!isHovered && !isSelected) continue;

      const entrance = Math.min(1, particle.age / 20);
      const nodeScale = scale * entrance;
      const radius = 7 * nodeScale;

      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.font = `${Math.max(10, Math.round(12 * scale))}px 'JetBrains Mono', monospace`;
      ctx.textAlign = "center";
      const label = particle.mem.id.length > 30 ? particle.mem.id.slice(0, 28) + ".." : particle.mem.id;
      const metrics = ctx.measureText(label);
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fillRect(sx - metrics.width / 2 - 6, sy - radius - 22, metrics.width + 12, 18);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, sx, sy - radius - 8);
      ctx.restore();
    }
  }, []);

  // Animation loop
  useEffect(() => {
    let raf: number;
    const loop = () => {
      const cam = cameraRef.current;
      if (cam.autoRotate && !dragRef.current.dragging) {
        cam.rotY += 0.0015;
      }
      renderAndStep();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [renderAndStep]);

  // Wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      cam.camZ -= e.deltaY * 0.8;
      cam.camZ = Math.max(-1500, Math.min(100, cam.camZ));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [loading]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY };
    cameraRef.current.autoRotate = false;
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      cameraRef.current.rotY += dx * 0.005;
      cameraRef.current.rotX += dy * 0.005;
      cameraRef.current.rotX = Math.max(-1.2, Math.min(1.2, cameraRef.current.rotX));
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      return;
    }

    // Hit test against current particle positions
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const cam = cameraRef.current;
    const particles = particlesRef.current;

    let closest = -1;
    let closestDist = 25;
    for (let i = 0; i < particles.length; i++) {
      let v = rotateY(particles[i].pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const p = project(v, w, h, cam.camZ);
      const dist = Math.hypot(p.sx - mx, p.sy - my);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHovered(closest);
    canvas.style.cursor = closest >= 0 ? "pointer" : "grab";
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current.dragging = false;
  }, []);

  const handleClick = useCallback(() => {
    const particles = particlesRef.current;
    if (hovered >= 0 && hovered < particles.length) {
      setHighlightId(particles[hovered].id);
      setFeedOpen(true);
    }
  }, [hovered]);

  const toggleType = useCallback((t: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="memviz">
        <div className="memviz-header">
          <button className="dash-back" onClick={onBack}>&larr; chat</button>
          <span className="dash-title">memory</span>
        </div>
        <div className="memviz-loading">loading memories...</div>
      </div>
    );
  }

  return (
    <div className="memviz">
      <div className="memviz-header">
        <button className="dash-back" onClick={onBack}>&larr; chat</button>
        <span className="dash-title">memory</span>
        <a className="dash-link" href="#dashboard">dashboard</a>
      </div>

      <FilterBar
        types={TYPE_ORDER}
        activeTypes={activeTypes}
        onToggle={toggleType}
        search={search}
        onSearch={setSearch}
        tagFilter={tagFilter}
        onTagFilter={setTagFilter}
        allTags={allTags}
        profileFilter={profileFilter}
        onProfileFilter={setProfileFilter}
        allProfiles={allProfiles}
      />

      <StatsBar memories={filtered} />

      <div className="memviz-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="memviz-canvas"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onClick={handleClick}
        />

        {!feedOpen && (
          <button className="memviz-feed-toggle" onClick={() => setFeedOpen(true)}>
            feed
          </button>
        )}

        {feedOpen && (
          <MemoryFeed
            memories={filtered}
            highlightId={highlightId}
            onClose={() => { setFeedOpen(false); setHighlightId(null); }}
          />
        )}

        <div className="memviz-controls-hint">
          drag to rotate · scroll to zoom · click node to find in feed
        </div>
      </div>
    </div>
  );
}
