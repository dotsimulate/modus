import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import { modus } from "../modusClient";
import type { MemoryItem } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";

// ── Custom dropdown (replaces native <select> for styled dropdowns) ──
function Dropdown({ value, options, placeholder, onChange }: {
  value: string;
  options: { value: string; label: ReactNode }[];
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : placeholder;

  return (
    <div className="custom-dropdown" ref={ref}>
      <button className="custom-dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
      </button>
      {open && (
        <div className="custom-dropdown-menu">
          <button
            className={`custom-dropdown-item${!value ? " active" : ""}`}
            onClick={() => { onChange(""); setOpen(false); }}
          >{placeholder}</button>
          {options.filter((o) => o.value).map((o) => (
            <button
              key={o.value}
              className={`custom-dropdown-item${o.value === value ? " active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Light markdown renderer ──
function renderInline(text: string): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  // Match **bold**, *italic*, `code` — non-greedy, no nesting
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2]) parts.push(<strong key={key++} className="md-bold">{match[2]}</strong>);
    else if (match[3]) parts.push(<em key={key++} className="md-italic">{match[3]}</em>);
    else if (match[4]) parts.push(<code key={key++} className="md-code">{match[4]}</code>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function LightMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const elements: React.ReactElement[] = [];
  let listItems: string[] = [];
  let codeBlock: string[] | null = null;
  let key = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={key++} className="md-list">
        {listItems.map((li, i) => <li key={i}>{renderInline(li)}</li>)}
      </ul>
    );
    listItems = [];
  };

  const flushCode = () => {
    if (!codeBlock) return;
    elements.push(
      <pre key={key++} className="md-codeblock"><code>{codeBlock.join("\n")}</code></pre>
    );
    codeBlock = null;
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    // Fenced code block toggle
    if (/^```/.test(trimmed)) {
      if (codeBlock === null) {
        flushList();
        codeBlock = [];
      } else {
        flushCode();
      }
      continue;
    }
    // Inside code block — collect raw lines
    if (codeBlock !== null) {
      codeBlock.push(line);
      continue;
    }
    // Bullet list
    if (/^[-*]\s/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s/, ""));
      continue;
    }
    flushList();
    // Heading
    if (/^#{1,3}\s/.test(trimmed)) {
      const content = trimmed.replace(/^#{1,3}\s/, "");
      elements.push(<div key={key++} className="md-heading">{renderInline(content)}</div>);
      continue;
    }
    // Blank line
    if (trimmed === "") continue;
    // Normal paragraph
    elements.push(<div key={key++} className="md-line">{renderInline(trimmed)}</div>);
  }
  flushList();
  flushCode(); // unclosed code block

  return <div className="md-body">{elements}</div>;
}

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
  return { sx: v.x * d + w * 0.45, sy: v.y * d + h / 2, scale: Math.max(0.1, d) };
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

// ── Temporal feed — chain-of-thought memory exploration ──

type FeedEntry = {
  mem: MemoryItem;
  viewedAt: number;   // Date.now() when collected
  dropKey: number;    // incremented when moved to top (triggers drop animation)
};

const FEED_TTL = 30_000; // ms before a memory drops off the feed

const EXIT_DURATION = 300; // ms — matches CSS animation length

function MemoryFeed({
  entries, onClose, onCardHover, onCardLeave, onExpire,
}: {
  entries: FeedEntry[];
  onClose: () => void;
  onCardHover?: (id: string) => void;
  onCardLeave?: () => void;
  onExpire: (ids: string[]) => void;
}) {
  const feedRef = useRef<HTMLDivElement>(null);
  const [dying, setDying] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  // Mark expired entries as dying, then remove after animation
  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      const expired = entries
        .filter(e => now - e.viewedAt >= FEED_TTL && !dying.has(e.mem.id))
        .map(e => e.mem.id);
      if (expired.length === 0) return;

      setDying(prev => {
        const next = new Set(prev);
        for (const id of expired) next.add(id);
        return next;
      });

      setTimeout(() => {
        onExpire(expired);
        setDying(prev => {
          const next = new Set(prev);
          for (const id of expired) next.delete(id);
          return next;
        });
      }, EXIT_DURATION);
    }, 200);
    return () => clearInterval(tick);
  }, [entries, onExpire, dying]);

  // Auto-scroll to top when new card drops in
  useEffect(() => {
    if (feedRef.current && entries.length > 0) {
      feedRef.current.scrollTop = 0;
    }
  }, [entries[0]?.dropKey, entries[0]?.mem.id]);

  const liveCount = entries.filter(e => !dying.has(e.mem.id)).length;

  return (
    <div className="memfeed" onClick={(e) => e.stopPropagation()}>
      <div className="memfeed-header">
        <span className="memfeed-title">memories</span>
        <span className="memfeed-count">{liveCount || ""}</span>
        <button className="memfeed-close" onClick={onClose}>&times;</button>
      </div>
      {entries.length === 0 ? (
        <div className="memfeed-empty">hover the void</div>
      ) : (
        <div className="memfeed-scroll" ref={feedRef}>
          {entries.map((entry, i) => {
            const isLatest = i === 0 && !dying.has(entry.mem.id);
            const isDying = dying.has(entry.mem.id);

            return (
              <div
                key={`${entry.mem.id}-${entry.dropKey}`}
                className={`memfeed-card${isLatest ? " memfeed-card-latest" : ""}${isDying ? " memfeed-card-exit" : ""}`}
                style={{ "--type-color": typeColor(entry.mem.type) } as React.CSSProperties}
                onMouseEnter={() => onCardHover?.(entry.mem.id)}
                onMouseLeave={() => onCardLeave?.()}
              >
                <span className="memfeed-dot" style={{ background: typeColor(entry.mem.type) }} />
                <div className="memfeed-card-content">
                  <div className="memfeed-card-id">
                    {entry.mem.id}
                    <button
                      className="memfeed-copy"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigator.clipboard.writeText(entry.mem.body);
                        setCopied(entry.mem.id);
                        setTimeout(() => setCopied(null), 1200);
                      }}
                    >
                      {copied === entry.mem.id ? "✓" : "⧉"}
                    </button>
                  </div>
                  <div className="memfeed-card-body"><LightMarkdown text={entry.mem.body} /></div>
                  {entry.mem.tags.length > 0 && (
                    <div className="memfeed-card-tags">
                      {entry.mem.tags.map((t) => <span key={t} className="memfeed-tag">{t}</span>)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Date range slider ──
function DateRangeSlider({ min, max, startVal, endVal, onStartChange, onEndChange, onReset }: {
  min: number; max: number;
  startVal: number; endVal: number;
  onStartChange: (v: number) => void;
  onEndChange: (v: number) => void;
  onReset: () => void;
}) {
  const isFullRange = startVal <= min && endVal >= max;
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // Percentage positions for the active track highlight
  const range = max - min || 1;
  const leftPct = ((startVal - min) / range) * 100;
  const rightPct = ((endVal - min) / range) * 100;

  return (
    <div className="memviz-date-slider">
      <div className="memviz-date-slider-track-wrap">
        <div className="memviz-date-slider-track">
          <div
            className="memviz-date-slider-active"
            style={{ left: `${leftPct}%`, width: `${rightPct - leftPct}%` }}
          />
        </div>
        <input
          type="range"
          className="memviz-date-input memviz-date-input-start"
          min={min}
          max={max}
          value={startVal}
          onChange={(e) => {
            const v = Number(e.target.value);
            onStartChange(Math.min(v, endVal));
          }}
        />
        <input
          type="range"
          className="memviz-date-input memviz-date-input-end"
          min={min}
          max={max}
          value={endVal}
          onChange={(e) => {
            const v = Number(e.target.value);
            onEndChange(Math.max(v, startVal));
          }}
        />
      </div>
      <div className="memviz-date-labels">
        <span className="memviz-date-label">{fmt(startVal)}</span>
        <button
          className={`memviz-date-reset${isFullRange ? " dimmed" : ""}`}
          onClick={onReset}
        >reset</button>
        <span className="memviz-date-label">{fmt(endVal)}</span>
      </div>
    </div>
  );
}

// ── Filter bar ──
function FilterBar({
  types, activeTypes, onToggle, search, onSearch,
  tagFilter, onTagFilter, allTags,
  profileFilter, onProfileFilter, allProfiles,
  dateRange, dateStart, dateEnd, onDateStartChange, onDateEndChange, onDateReset,
}: {
  types: string[]; activeTypes: Set<string>; onToggle: (t: string) => void;
  search: string; onSearch: (s: string) => void;
  tagFilter: string; onTagFilter: (t: string) => void; allTags: string[];
  profileFilter: string; onProfileFilter: (p: string) => void; allProfiles: string[];
  dateRange: { min: number; max: number } | null;
  dateStart: number; dateEnd: number;
  onDateStartChange: (v: number) => void;
  onDateEndChange: (v: number) => void;
  onDateReset: () => void;
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
      <Dropdown
        value={tagFilter}
        placeholder="all tags"
        options={allTags.map((t) => ({ value: t, label: t }))}
        onChange={onTagFilter}
      />
      {allProfiles.length > 0 && (
        <Dropdown
          value={profileFilter}
          placeholder="all profiles"
          options={allProfiles.map((p) => ({ value: p, label: p }))}
          onChange={onProfileFilter}
        />
      )}
      {dateRange && (
        <DateRangeSlider
          min={dateRange.min}
          max={dateRange.max}
          startVal={dateStart}
          endVal={dateEnd}
          onStartChange={onDateStartChange}
          onEndChange={onDateEndChange}
          onReset={onDateReset}
        />
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
export function MemoryViz({ initialTagFilter }: { initialTagFilter?: string } = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [hovered, setHovered] = useState<number>(-1);
  const { activeUserProfile, activeCwd } = useProfiles();

  // Feed state — temporal stack of explored memories
  const [feedStack, setFeedStack] = useState<FeedEntry[]>([]);
  const [feedOpen, setFeedOpen] = useState(true);
  const [clickedId, setClickedId] = useState<string | null>(null);
  const [feedHoverId, setFeedHoverId] = useState<string | null>(null);
  const lastPushedIdRef = useRef<string | null>(null);

  // Filters
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(TYPE_ORDER));
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState(initialTagFilter ?? "");
  const [profileFilter, setProfileFilter] = useState("");
  const [dateStart, setDateStart] = useState(0);
  const [dateEnd, setDateEnd] = useState(0);

  // Camera
  const cameraRef = useRef({ rotY: 0.4, rotX: -0.25, camZ: -125, panX: 0, panY: 0, autoRotate: true });
  const dragRef = useRef({ dragging: false, button: 0, lastX: 0, lastY: 0 });

  // Physics particles — mutable ref, updated every frame
  const particlesRef = useRef<Particle[]>([]);

  useEffect(() => {
    setLoading(true);
    modus.queryMemories({ userProfile: activeUserProfile ?? undefined, cwd: activeCwd })
      .then((m) => { setMemories(m); setLoading(false); })
      .catch(() => setLoading(false));
  }, [activeUserProfile, activeCwd]);

  // Date range bounds from all memories
  const dateRange = useMemo(() => {
    if (memories.length === 0) return null;
    let min = Infinity, max = -Infinity;
    for (const m of memories) {
      const ts = new Date(m.created).getTime();
      if (!isNaN(ts)) {
        if (ts < min) min = ts;
        if (ts > max) max = ts;
      }
    }
    return min <= max ? { min, max } : null;
  }, [memories]);

  // Initialize date range when memories first load
  useEffect(() => {
    if (dateRange) {
      setDateStart(dateRange.min);
      setDateEnd(dateRange.max);
    }
  }, [dateRange]);

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

  // Which types have any matches (ignoring type toggle) — for hiding empty type buttons
  const visibleTypes = useMemo(() => {
    const types = new Set<string>();
    for (const m of memories) {
      if (tagFilter && !m.tags.includes(tagFilter)) continue;
      if (profileFilter && m.profile !== profileFilter) continue;
      if (search) {
        const s = search.toLowerCase();
        if (!m.id.toLowerCase().includes(s)
          && !m.body.toLowerCase().includes(s)
          && !m.tags.some((t) => t.toLowerCase().includes(s))) continue;
      }
      if (dateRange) {
        const ts = new Date(m.created).getTime();
        if (ts < dateStart || ts > dateEnd) continue;
      }
      types.add(m.type || "discovery");
    }
    return types;
  }, [memories, search, tagFilter, profileFilter, dateRange, dateStart, dateEnd]);

  const filtered = useMemo(() => {
    return memories.filter((m) => {
      if (!activeTypes.has(m.type || "discovery")) return false;
      if (tagFilter && !m.tags.includes(tagFilter)) return false;
      if (profileFilter && m.profile !== profileFilter) return false;
      if (dateRange) {
        const ts = new Date(m.created).getTime();
        if (ts < dateStart || ts > dateEnd) return false;
      }
      if (search) {
        const s = search.toLowerCase();
        return m.id.toLowerCase().includes(s)
          || m.body.toLowerCase().includes(s)
          || m.tags.some((t) => t.toLowerCase().includes(s));
      }
      return true;
    });
  }, [memories, activeTypes, search, tagFilter, profileFilter, dateRange, dateStart, dateEnd]);

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

  // ── Hover → collect into feed ──
  useEffect(() => {
    const particles = particlesRef.current;
    if (hovered < 0 || hovered >= particles.length) {
      lastPushedIdRef.current = null;
      return;
    }

    const mem = particles[hovered].mem;
    if (mem.id === lastPushedIdRef.current) return;
    lastPushedIdRef.current = mem.id;

    setFeedStack(prev => {
      // Already at top — refresh timestamp but no re-animation
      if (prev.length > 0 && prev[0].mem.id === mem.id) {
        return [{ ...prev[0], viewedAt: Date.now() }, ...prev.slice(1)];
      }
      // Move to top (or add new)
      const existing = prev.find(e => e.mem.id === mem.id);
      const rest = prev.filter(e => e.mem.id !== mem.id);
      const dropKey = (existing?.dropKey ?? 0) + 1;
      return [{ mem, viewedAt: Date.now(), dropKey }, ...rest];
    });

    setFeedOpen(true);
  }, [hovered]);

  // Connections are derived from current particles (recomputed each frame is fine for 60 nodes)
  const connectionsRef = useRef<[number, number][]>([]);

  // Canvas rendering + physics step combined in the animation loop
  const hoveredRef = useRef(-1);
  const selectedRef = useRef<string | null>(null);
  hoveredRef.current = hovered;
  // Effective highlight: feed card hover overrides click selection
  const effectiveHighlight = feedHoverId || clickedId;
  selectedRef.current = effectiveHighlight;

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
    const { panX, panY } = cam;
    const transformed = particles.map((p, i) => {
      let v = rotateY(p.pos, cam.rotY);
      v = rotateX(v, cam.rotX);
      const proj = project(v, w, h, cam.camZ);
      return { sx: proj.sx + panX, sy: proj.sy + panY, scale: proj.scale, particle: p, idx: i, z: v.z };
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
      ctx.moveTo(pa.sx + panX, pa.sy + panY);
      ctx.lineTo(pb.sx + panX, pb.sy + panY);
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
        ctx.fillText(t, p.sx + panX, p.sy + panY);
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
    dragRef.current = { dragging: true, button: e.button, lastX: e.clientX, lastY: e.clientY };
    cameraRef.current.autoRotate = false;
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      if (dragRef.current.button === 2) {
        // Right drag — pan camera look-at
        cameraRef.current.panX += dx;
        cameraRef.current.panY += dy;
      } else {
        // Left drag — rotate
        cameraRef.current.rotY += dx * 0.005;
        cameraRef.current.rotX += dy * 0.005;
        cameraRef.current.rotX = Math.max(-1.2, Math.min(1.2, cameraRef.current.rotX));
      }
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
      const dist = Math.hypot((p.sx + cam.panX) - mx, (p.sy + cam.panY) - my);
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
      const mem = particles[hovered].mem;
      setClickedId(mem.id);
      setFeedOpen(true);
      // Also push to feed on click
      setFeedStack(prev => {
        if (prev.length > 0 && prev[0].mem.id === mem.id) {
          return [{ ...prev[0], viewedAt: Date.now() }, ...prev.slice(1)];
        }
        const existing = prev.find(e => e.mem.id === mem.id);
        const rest = prev.filter(e => e.mem.id !== mem.id);
        const dropKey = (existing?.dropKey ?? 0) + 1;
        return [{ mem, viewedAt: Date.now(), dropKey }, ...rest];
      });
    }
  }, [hovered]);

  const handleExpire = useCallback((ids: string[]) => {
    setFeedStack(prev => prev.filter(e => !ids.includes(e.mem.id)));
  }, []);

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
        <div className="memviz-loading">loading memories...</div>
      </div>
    );
  }

  return (
    <div className="memviz">
      <FilterBar
        types={TYPE_ORDER.filter(t => visibleTypes.has(t))}
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
        dateRange={dateRange}
        dateStart={dateStart}
        dateEnd={dateEnd}
        onDateStartChange={setDateStart}
        onDateEndChange={setDateEnd}
        onDateReset={() => { if (dateRange) { setDateStart(dateRange.min); setDateEnd(dateRange.max); } }}
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
          onContextMenu={handleContextMenu}
          onClick={handleClick}
        />

        {!feedOpen && (
          <button className="memviz-feed-toggle" onClick={() => setFeedOpen(true)}>
            feed
          </button>
        )}

        {feedOpen && (
          <MemoryFeed
            entries={feedStack}
            onClose={() => { setFeedOpen(false); setClickedId(null); }}
            onCardHover={(id) => setFeedHoverId(id)}
            onCardLeave={() => setFeedHoverId(null)}
            onExpire={handleExpire}
          />
        )}

        <div className="memviz-controls-hint">
          drag to rotate · right-drag to pan · scroll to zoom · hover to collect
        </div>
      </div>
    </div>
  );
}
