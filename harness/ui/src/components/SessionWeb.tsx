import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, memo } from "react";
import { fetchSessionsScoped } from "../api/sessions";
import { fetchGitLog } from "../api/git";
import { API_BASE, authHeaders } from "../api/_fetch";
import { fetchMissionRuns, fetchMissionTransfers, fetchMissionSessions } from "../api/missions";
import { fetchTouches } from "../api/trace";
import { archiveSessionApi, createSession, createEmptySession, addSessionTagApi, removeSessionTagApi } from "../api/sessions";
import { fetchWebPositions, patchWebPositions } from "../api/web-positions";
import type { SessionInfo, GitCommit } from "../api/types";
import type { MissionRunSummary, MissionTransferSummary } from "../api/missions";
import type { TouchRecord } from "../api/trace";
import { ChatFileViewer } from "./ChatFileViewer";
import { SessionWindow } from "./SessionWindow";
import { WebComposer } from "./WebComposer";
import { CustomSelect, type SelectOption } from "./CustomSelect";
import { useProfiles } from "../providers/ProfileProvider";

import {
  type MoveRun,
  type GraphNode,
  type EdgeType,
  type EdgeLayers,
  type WebLayoutConfig,
  type PositionMap,
  type DateFilter,
  type TimeCluster,
  NODE_W, NODE_H, DOC_W, DOC_H, COMMIT_W, COMMIT_H,
  loadConfig, saveConfig,
  loadDateFilter, saveDateFilter,
  loadLayers, saveLayers,
  shortId, shortHash, formatCost, timeAgo,
  parseTags,
  dayKey,
} from "./SessionWebLayout";

import { buildAllEdges } from "./SessionWebEdges";
import { solveLayout } from "./SessionWebSolver";

// ── Viewport type ──

type Viewport = { x: number; y: number; scale: number };
type CullingState = { left: number; top: number; right: number; bottom: number; scale: number };
type MinimapTag = { id: string; label: string; x: number; y: number };

// ── Node dimension helper ──

function nodeDims(type: GraphNode["type"]): { w: number; h: number } {
  if (type === "session") return { w: NODE_W, h: NODE_H };
  if (type === "document") return { w: DOC_W, h: DOC_H };
  return { w: COMMIT_W, h: COMMIT_H };
}

// ── Nearest-edge anchor point between two nodes ──

function nearestAnchor(
  n: GraphNode,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  const { w, h } = nodeDims(n.type);
  const cx = n.x + w / 2;
  const cy = n.y + h / 2;
  const dx = targetX - cx;
  const dy = targetY - cy;
  const scaleX = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);
  if (!isFinite(scale)) return { x: cx, y: cy };
  return {
    x: cx + dx * Math.min(scale, 1),
    y: cy + dy * Math.min(scale, 1),
  };
}

// ── SVG Edge ──

function EdgePath({ from, to, type, lane = 0 }: {
  from: GraphNode;
  to: GraphNode;
  type: EdgeType;
  lane?: number;
}) {
  const fromD = nodeDims(from.type), toD = nodeDims(to.type);
  const fromCx = from.x + fromD.w / 2, fromCy = from.y + fromD.h / 2;
  const toCx = to.x + toD.w / 2, toCy = to.y + toD.h / 2;

  const p1 = nearestAnchor(from, toCx, toCy);
  const p2 = nearestAnchor(to, fromCx, fromCy);

  if (type === "commit") {
    const d = `M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}`;
    return <path d={d} className="web-edge web-edge--commit" />;
  }

  if (type === "document") {
    return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="web-edge web-edge--document" />;
  }

  if (type === "delegation") {
    const laneOffset = 18 + lane * 14;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const nx = -dy / (dist || 1) * laneOffset;
    const ny = dx / (dist || 1) * laneOffset;
    const mx = (p1.x + p2.x) / 2 + nx;
    const my = (p1.y + p2.y) / 2 + ny;
    const d = `M ${p1.x} ${p1.y} Q ${mx} ${my}, ${p2.x} ${p2.y}`;
    return <path d={d} className="web-edge web-edge--delegation" />;
  }

  if (type === "co-edit" || type === "co-read") {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const dist = Math.hypot(dx, dy);
    const cp = Math.min(dist * 0.25, 50);
    const nx = -dy / (dist || 1) * cp;
    const ny = dx / (dist || 1) * cp;
    const d = `M ${p1.x} ${p1.y} Q ${(p1.x + p2.x) / 2 + nx} ${(p1.y + p2.y) / 2 + ny}, ${p2.x} ${p2.y}`;
    const cls = type === "co-edit" ? "web-edge web-edge--co-edit" : "web-edge web-edge--co-read";
    return <path d={d} className={cls} />;
  }

  // Handoff — straight line
  return <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} className="web-edge web-edge--handoff" />;
}

// ── Mission Filter Panel ──

function MissionFilterPanel({ runs, activeRunId, onChange }: {
  runs: MissionRunSummary[];
  activeRunId: number | null;
  onChange: (runId: number | null) => void;
}) {
  if (runs.length === 0) return null;
  const options: SelectOption[] = [
    { value: "", label: "all missions" },
    ...runs.map(r => ({ value: String(r.id), label: `${r.missionName} #${r.id} (${r.status})` })),
  ];
  return (
    <div className="web-mission-filter" onMouseDown={e => e.stopPropagation()}>
      <CustomSelect
        options={options}
        value={activeRunId != null ? String(activeRunId) : ""}
        placeholder="all missions"
        onChange={v => onChange(v === "" ? null : Number(v))}
      />
    </div>
  );
}

// ── Date Filter Panel ──

function DateFilterPanel({ filter, onChange }: {
  filter: DateFilter;
  onChange: (f: DateFilter) => void;
}) {
  return (
    <div className="web-date-filter" onMouseDown={e => e.stopPropagation()}>
      <label>from</label>
      <input
        type="date"
        value={filter.startDate ?? ""}
        onChange={e => onChange({ ...filter, startDate: e.target.value || null })}
      />
      <label>to</label>
      <input
        type="date"
        value={filter.endDate ?? ""}
        onChange={e => onChange({ ...filter, endDate: e.target.value || null })}
      />
      {(filter.startDate || filter.endDate) && (
        <button
          className="web-date-filter-clear"
          onClick={() => onChange({ startDate: null, endDate: null })}
        >clear</button>
      )}
    </div>
  );
}

// ── Edge Layer Panel ──

function EdgeLayerPanel({ layers, onChange }: {
  layers: EdgeLayers;
  onChange: (l: EdgeLayers) => void;
}) {
  const items: [keyof EdgeLayers, string][] = [
    ["handoff", "handoffs"],
    ["delegation", "delegations"],
    ["commit", "commits"],
    ["co-edit", "co-edits"],
    ["co-read", "co-reads"],
  ];
  return (
    <div className="web-layer-panel" onMouseDown={e => e.stopPropagation()}>
      {items.map(([key, label]) => (
        <label key={key} className={`web-layer-toggle${layers[key] ? " active" : ""}`}>
          <input
            type="checkbox"
            checked={layers[key]}
            onChange={e => onChange({ ...layers, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
    </div>
  );
}

// ── Layout Panel ──

function LayoutPanel({ config, onChange, onRegenerate }: {
  config: WebLayoutConfig;
  onChange: (cfg: WebLayoutConfig) => void;
  onRegenerate: () => void;
}) {
  const [open, setOpen] = useState(false);

  const set = <K extends keyof WebLayoutConfig>(key: K, value: WebLayoutConfig[K]) =>
    onChange({ ...config, [key]: value });

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
            <button className="web-layout-regen" onClick={onRegenerate}>
              regenerate layout
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail Panel ──

function DetailPanel({ node, onClose, onArchive, onPinToggle }: { node: GraphNode; onClose: () => void; onArchive?: (id: string) => void; onPinToggle?: (id: string) => void }) {
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
      <div className="web-detail-actions">
        {onPinToggle && (
          <button className={`web-detail-pin${tags.includes("pinned") ? " web-detail-pin--pinned" : ""}`} onClick={() => onPinToggle(s.id)}>
            {tags.includes("pinned") ? "unpin" : "pin"}
          </button>
        )}
        {onArchive && (
          <button className="web-detail-archive" onClick={() => onArchive(s.id)}>
            archive
          </button>
        )}
      </div>
    </div>
  );
}

// ── Context Menu ──

type ContextMenuState =
  | { kind: "session"; x: number; y: number; sessionId: string }
  | { kind: "canvas"; x: number; y: number; canvasX: number; canvasY: number };

function SessionContextMenu({ x, y, session, onCopyId, onPinToggle, onArchive, onClose }: {
  x: number;
  y: number;
  session: SessionInfo;
  onCopyId: () => void;
  onPinToggle: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  const isPinned = parseTags(session.tags).includes("pinned");
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    window.addEventListener("contextmenu", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
    };
  }, [onClose]);

  return (
    <div className="web-context-menu" style={{ left: x, top: y }} onMouseDown={e => e.stopPropagation()}>
      <button onClick={onCopyId}>copy id</button>
      <button onClick={onPinToggle}>{isPinned ? "unpin" : "pin"}</button>
      <div className="web-context-sep" />
      <button className="web-context-danger" onClick={onArchive}>archive</button>
    </div>
  );
}

function CanvasContextMenu({ x, y, profiles, onNewSession, onClose }: {
  x: number;
  y: number;
  profiles: string[];
  onNewSession: (profile?: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    window.addEventListener("contextmenu", handler);
    return () => {
      window.removeEventListener("click", handler);
      window.removeEventListener("contextmenu", handler);
    };
  }, [onClose]);

  return (
    <div className="web-context-menu" style={{ left: x, top: y }} onMouseDown={e => e.stopPropagation()}>
      {profiles.length <= 1 ? (
        <button onClick={() => onNewSession(profiles[0])}>new session</button>
      ) : (
        <>
          <div className="web-context-label">new session</div>
          {profiles.map(p => (
            <button key={p} onClick={() => onNewSession(p)}>&nbsp;&nbsp;{p}</button>
          ))}
        </>
      )}
    </div>
  );
}

// ── Memoized Node Components ──
// These only re-render when their own props change.
// Viewport pan/zoom does NOT touch these — that's the perf win.

const SessionNodeEl = memo(function SessionNodeEl({ node, isSelected, isNeighbor, isDragging, touchCounts, onSelect, onOpen, onDragStart, onContextMenu, onHover, onNodeTouchEnd }: {
  node: GraphNode;
  isSelected: boolean;
  isNeighbor: boolean;
  isDragging: boolean;
  touchCounts: { reads: number; edits: number } | undefined;
  onSelect: (node: GraphNode, e: React.MouseEvent) => void;
  onOpen: (sessionId: string) => void;
  onDragStart: (e: React.MouseEvent, nodeId: string) => void;
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void;
  onHover: (id: string | null) => void;
  onNodeTouchEnd: (nodeId: string, doubleAction: () => void) => void;
}) {
  const s = node.session!;
  const statusClass = s.status === "running" ? "running" : s.status === "error" ? "error" : "done";
  const isPinned = (node.tags || []).includes("pinned");
  return (
    <div
      className={`web-session-node web-session-node--${statusClass}${isSelected ? " web-node--selected" : ""}${!isSelected && isNeighbor ? " web-node--neighbor" : ""}${isDragging ? " web-session-node--dragging" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(e) => onSelect(node, e)}
      onDoubleClick={() => onOpen(s.id)}
      onTouchEnd={() => onNodeTouchEnd(node.id, () => onOpen(s.id))}
      onMouseDown={(e) => onDragStart(e, node.id)}
      onContextMenu={(e) => onContextMenu(e, s.id)}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="web-session-top">
        <span className={`web-session-dot web-session-dot--${statusClass}`} />
        <span className="web-session-title">
          {(s.title || s.preview || "—").slice(0, 52)}
        </span>
        {isPinned && <span className="web-session-pin">◆</span>}
      </div>
      <div className="web-session-sub">
        {s.profile && <span className="web-session-profile">{s.profile}</span>}
        {node.handoffType && <span className="web-session-handoff-type">{node.handoffType}</span>}
      </div>
      <div className="web-session-meta">
        <span>{s.message_count} msgs</span>
        {s.total_cost_usd > 0 && <span>{formatCost(s.total_cost_usd)}</span>}
        {touchCounts && (
          <>
            {touchCounts.reads > 0 && <span className="web-session-reads">{touchCounts.reads}r</span>}
            {touchCounts.edits > 0 && <span className="web-session-edits">{touchCounts.edits}w</span>}
          </>
        )}
        <span className="web-session-time">{timeAgo(s.created_at)}</span>
      </div>
    </div>
  );
});

const CommitNodeEl = memo(function CommitNodeEl({ node, isSelected, isNeighbor, onSelect, onHover }: {
  node: GraphNode;
  isSelected: boolean;
  isNeighbor: boolean;
  onSelect: (node: GraphNode, e: React.MouseEvent) => void;
  onHover: (id: string | null) => void;
}) {
  const c = node.commit!;
  return (
    <div
      className={`web-commit-node${isSelected ? " web-node--selected" : ""}${!isSelected && isNeighbor ? " web-node--neighbor" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(e) => onSelect(node, e)}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      title={c.message}
    >
      <span className="web-commit-hash">{shortHash(c.hash)}</span>
      <span className="web-commit-msg">{c.message.split("\n")[0].slice(0, 34)}</span>
    </div>
  );
});

const DocNodeEl = memo(function DocNodeEl({ node, isSelected, isNeighbor, onSelect, onOpenFile, onHover, onNodeTouchEnd }: {
  node: GraphNode;
  isSelected: boolean;
  isNeighbor: boolean;
  onSelect: (node: GraphNode, e: React.MouseEvent) => void;
  onOpenFile: (path: string) => void;
  onHover: (id: string | null) => void;
  onNodeTouchEnd: (nodeId: string, doubleAction: () => void) => void;
}) {
  const d = node.doc!;
  return (
    <div
      className={`web-doc-node${isSelected ? " web-node--selected" : ""}${!isSelected && isNeighbor ? " web-node--neighbor" : ""}`}
      style={{ left: node.x, top: node.y }}
      onClick={(e) => onSelect(node, e)}
      onDoubleClick={() => onOpenFile(d.path)}
      onTouchEnd={() => onNodeTouchEnd(node.id, () => onOpenFile(d.path))}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      title={d.path}
    >
      <span className="web-doc-icon">&#9654;</span>
      <span className="web-doc-name">{d.filename.replace(/-handoff\.md$/, "")}</span>
    </div>
  );
});

// ── Stable empty positions object — returned by solver when nothing to solve ──
const EMPTY_POS: PositionMap = {};

// ── Main Component ──

export function SessionWeb() {
  const { activeUserProfile, activeUP, visibleProfiles } = useProfiles();
  const profileName = activeUserProfile ?? "default";

  // ── Data state ──
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [moveRuns, setMoveRuns] = useState<MoveRun[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [missionRuns, setMissionRuns] = useState<MissionRunSummary[]>([]);
  const [missionTransfers, setMissionTransfers] = useState<MissionTransferSummary[]>([]);
  const [touches, setTouches] = useState<TouchRecord[]>([]);
  const [missionFilter, setMissionFilter] = useState<number | null>(null);
  const [missionFilterSessionIds, setMissionFilterSessionIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);

  // ── UI state ──
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [lassoRect, setLassoRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [minimapTags, setMinimapTags] = useState<MinimapTag[]>(() => {
    try { return JSON.parse(localStorage.getItem(`web-mm-tags-${profileName}`) ?? "[]"); }
    catch { return []; }
  });
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null);
  const [miniSessionId, setMiniSessionId] = useState<string | null>(null);
  const [config, setConfig] = useState<WebLayoutConfig>(() => loadConfig());
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => loadDateFilter(profileName));
  const [edgeLayers, setEdgeLayers] = useState<EdgeLayers>(() => loadLayers(profileName));
  // Positions from backend — the single source of truth
  const [storedPositions, setStoredPositions] = useState<PositionMap>({});
  // Gate: solver must NOT run until positions have been fetched from the API.
  // Without this, the solver sees an empty positionMap on mount and re-solves
  // every session from scratch, overwriting the stored positions.
  const [positionsLoaded, setPositionsLoaded] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [composerState, setComposerState] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [draggingChain, setDraggingChain] = useState<Set<string> | null>(null);
  const [dragPreview, setDragPreview] = useState<PositionMap>({});

  // ── Viewport: ref-based for zero-cost pan/zoom ──
  // viewportRef is the source of truth, updated every frame.
  // cullingState is a debounced snapshot that triggers React re-renders
  // ONLY for frustum culling + LOD updates.
  const viewportRef = useRef<Viewport>(() => {
    const cfg = loadConfig();
    return { x: cfg.padX, y: cfg.padY, scale: 1 };
  });
  // Initialize eagerly so the ref holds an object, not a function
  if (typeof viewportRef.current === "function") {
    viewportRef.current = (viewportRef.current as unknown as () => Viewport)();
  }

  const [cullingState, setCullingState] = useState<CullingState>(() => {
    const vp = viewportRef.current;
    const M = 300;
    return { left: -vp.x - M, top: -vp.y - M, right: -vp.x + 2000 + M, bottom: -vp.y + 1200 + M, scale: vp.scale };
  });
  const cullRafRef = useRef(0);

  // ── DOM refs ──
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const mmRectRef = useRef<SVGRectElement>(null);
  const svgWRef = useRef(800);
  const svgHRef = useRef(600);

  // ── Interaction refs ──
  const dragRef = useRef<{ startX: number; startY: number; vpX: number; vpY: number; hasMoved?: boolean } | null>(null);
  const touchRef = useRef<{
    startX: number; startY: number; vpX: number; vpY: number;
    initialDistance?: number; initialScale?: number; hasMoved?: boolean;
  } | null>(null);
  const autoCenteredRef = useRef(false);
  const lastTapRef = useRef<{ id: string; time: number } | null>(null);
  const nodeDragRef = useRef<{
    nodeId: string; startX: number; startY: number;
    origX: number; origY: number; chainIds: string[];
    origPositions: Record<string, { x: number; y: number }>;
    hasMoved: boolean;
  } | null>(null);
  const mmDragRef = useRef<{ startX: number; startY: number; startVpX: number; startVpY: number; hasMoved: boolean } | null>(null);
  const lassoRef = useRef<{ startClientX: number; startClientY: number; startCanvasX: number; startCanvasY: number } | null>(null);

  // ── applyViewport: the single function that drives all viewport updates ──
  // Updates the DOM directly (no React render), then schedules a debounced
  // culling state sync on the next animation frame.
  function applyViewport(vp: Viewport) {
    viewportRef.current = vp;

    // Direct DOM: canvas transform
    if (canvasRef.current) {
      canvasRef.current.style.transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`;
      canvasRef.current.classList.toggle("web-canvas--zoomed-out", vp.scale < 0.4);
    }

    // Direct DOM: minimap viewport rect
    const wrap = wrapRef.current;
    if (mmRectRef.current && wrap) {
      const mmH = 80;
      const scaleX = wrap.clientWidth / svgWRef.current;
      const scaleY = mmH / svgHRef.current;
      const vpW = wrap.clientWidth;
      const vpH = wrap.clientHeight;
      const vrX = Math.max(0, (-vp.x / vp.scale) * scaleX);
      const vrY = Math.max(0, (-vp.y / vp.scale) * scaleY);
      const vrW = Math.min(wrap.clientWidth - vrX, (vpW / vp.scale) * scaleX);
      const vrH = Math.min(mmH - vrY, (vpH / vp.scale) * scaleY);
      mmRectRef.current.setAttribute("x", String(vrX));
      mmRectRef.current.setAttribute("y", String(vrY));
      mmRectRef.current.setAttribute("width", String(vrW));
      mmRectRef.current.setAttribute("height", String(vrH));
    }

    // Debounced React state update for frustum culling + LOD
    cancelAnimationFrame(cullRafRef.current);
    cullRafRef.current = requestAnimationFrame(() => {
      const w = wrapRef.current;
      if (!w) return;
      const M = 200;
      setCullingState({
        left: -vp.x / vp.scale - M,
        top: -vp.y / vp.scale - M,
        right: -vp.x / vp.scale + w.clientWidth / vp.scale + M * 2,
        bottom: -vp.y / vp.scale + w.clientHeight / vp.scale + M * 2,
        scale: vp.scale,
      });
    });
  }

  // ── Persistence effects ──
  useEffect(() => { saveConfig(config); }, [config]);
  useEffect(() => { saveDateFilter(profileName, dateFilter); }, [dateFilter, profileName]);
  useEffect(() => { saveLayers(profileName, edgeLayers); }, [edgeLayers, profileName]);

  // ── Fetch all data ──
  useEffect(() => {
    let cancelled = false;
    // Reset gate while fetching — solver must wait for fresh positions
    setPositionsLoaded(false);
    async function load() {
      try {
        const projectCwd = activeUP?.projects?.[0];
        const [sessData, moveData, gitData, runsData, touchData, posData] = await Promise.all([
          fetchSessionsScoped(500, activeUserProfile ?? undefined),
          fetch(`${API_BASE}/api/move-runs/recent?limit=200`, { headers: authHeaders() }).then(r => r.json()),
          fetchGitLog(projectCwd ?? ".", 100).catch(() => [] as GitCommit[]),
          fetchMissionRuns(projectCwd ? { cwd: projectCwd } : undefined).catch(() => [] as MissionRunSummary[]),
          fetchTouches({
            userProfile: activeUserProfile ?? undefined,
            cwd: projectCwd ?? undefined,
            ops: ["write", "edit", "read"],
            limit: 5000,
          }).catch(() => ({ touches: [] as TouchRecord[], summary: {} })),
          fetchWebPositions(profileName),
        ]);
        if (cancelled) return;
        setSessions(sessData);
        setMoveRuns(moveData);
        setCommits(gitData);
        setMissionRuns(runsData);
        setTouches(touchData.touches);
        // Convert API positions array to PositionMap
        const posMap: PositionMap = {};
        for (const p of posData) posMap[p.nodeId] = { x: p.x, y: p.y };
        setStoredPositions(posMap);
        setPositionsLoaded(true);
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

  // ── Mission filter ──
  useEffect(() => {
    if (missionFilter === null) { setMissionFilterSessionIds(null); return; }
    let cancelled = false;
    fetchMissionSessions(missionFilter).then(ids => {
      if (!cancelled) setMissionFilterSessionIds(new Set(ids));
    }).catch(() => { if (!cancelled) setMissionFilterSessionIds(null); });
    return () => { cancelled = true; };
  }, [missionFilter]);

  // ── Filtered sessions ──
  const filteredSessions = useMemo(() => {
    let result = sessions;
    if (missionFilterSessionIds) result = result.filter(s => missionFilterSessionIds.has(s.id));
    if (dateFilter.startDate) {
      const startTs = new Date(dateFilter.startDate).getTime();
      result = result.filter(s => s.created_at >= startTs);
    }
    if (dateFilter.endDate) {
      const endTs = new Date(dateFilter.endDate).getTime() + 86400000;
      result = result.filter(s => s.created_at < endTs);
    }
    return result;
  }, [sessions, missionFilterSessionIds, dateFilter]);

  const filteredTransfers = useMemo(() => {
    if (!missionFilter) return missionTransfers;
    return missionTransfers.filter(t => {
      if (!missionFilterSessionIds) return true;
      return (t.fromSessionId && missionFilterSessionIds.has(t.fromSessionId)) ||
             (t.toSessionId && missionFilterSessionIds.has(t.toSessionId));
    });
  }, [missionTransfers, missionFilter, missionFilterSessionIds]);

  // ── Per-session file touch counts ──
  const sessionTouchCounts = useMemo(() => {
    const counts = new Map<string, { reads: number; edits: number }>();
    for (const t of touches) {
      const c = counts.get(t.sessionId) || { reads: 0, edits: 0 };
      if (t.op === "read") c.reads++;
      else if (t.op === "write" || t.op === "edit") c.edits++;
      counts.set(t.sessionId, c);
    }
    return counts;
  }, [touches]);

  // ── Build edges then solve layout ──
  const { edges, handoffDocs, commitSessionMap, childrenOf, spawnedSet } = useMemo(
    () => buildAllEdges(filteredSessions, moveRuns, commits, filteredTransfers, touches),
    [filteredSessions, moveRuns, commits, filteredTransfers, touches],
  );

  // ── Solver: only runs for sessions with no stored position ──
  // CRITICAL: Do NOT run until positionsLoaded is true. Otherwise the solver
  // sees an empty storedPositions map on mount and re-solves every session,
  // overwriting the persisted DB positions. This was the core bug.
  const solvedPositions = useMemo((): PositionMap => {
    if (!positionsLoaded) return EMPTY_POS;
    const unsolvedSessions = filteredSessions.filter(s => !storedPositions[s.id]);
    if (unsolvedSessions.length === 0) return EMPTY_POS;
    const result = solveLayout(
      filteredSessions, edges, handoffDocs, commitSessionMap,
      childrenOf, spawnedSet, commits, config, storedPositions, touches,
    );
    const newPositions: PositionMap = {};
    for (const n of result.nodes) {
      if (n.type === "session" && !storedPositions[n.id]) {
        newPositions[n.id] = { x: n.x, y: n.y };
      }
    }
    return Object.keys(newPositions).length > 0 ? newPositions : EMPTY_POS;
  }, [positionsLoaded, filteredSessions, edges, handoffDocs, commitSessionMap, childrenOf, spawnedSet, commits, config, storedPositions, touches]);

  // ── Persist newly solved positions and lock them into storedPositions ──
  // Runs only when solvedPositions actually changes (new sessions appeared).
  useEffect(() => {
    const keys = Object.keys(solvedPositions);
    if (keys.length === 0) return;
    const batch = keys.map(nodeId => ({
      nodeId, x: solvedPositions[nodeId].x, y: solvedPositions[nodeId].y, pinned: false,
    }));
    patchWebPositions(profileName, batch);
    setStoredPositions(prev => ({ ...prev, ...solvedPositions }));
  }, [solvedPositions, profileName]);

  // ── Build nodes from positions ──
  // Pure node-building — no solver, no side effects.
  // Re-runs only when: sessions change, positions change (load/drag-end), or dragPreview changes (during drag).
  const { nodes, clusters } = useMemo(() => {
    // Merge: solvedPositions fill gaps, storedPositions win for placed nodes, dragPreview wins during drag
    const allPositions: PositionMap = { ...solvedPositions, ...storedPositions, ...dragPreview };

    // Build session nodes from positions
    const nodeList: GraphNode[] = [];
    const sorted = [...filteredSessions].sort((a, b) => a.created_at - b.created_at);
    for (const s of sorted) {
      const pos = allPositions[s.id];
      if (!pos) continue; // shouldn't happen after solve, but guard
      const tags = parseTags(s.tags);
      const handoffType = tags.find(t => t.startsWith("handoff:"))?.slice(8);
      nodeList.push({
        id: s.id,
        type: "session",
        x: pos.x, y: pos.y,
        col: spawnedSet.has(s.id) ? 1 : 0,
        row: 0,
        session: s,
        tags,
        handoffType,
        dayKey: dayKey(s.created_at),
      });
    }

    // Build commit nodes — placed relative to parent session
    const COMMIT_COLS = 3;
    const commitsByParent = new Map<string, GitCommit[]>();
    const orphanCommits: GitCommit[] = [];
    for (const c of commits) {
      const h7 = shortHash(c.hash);
      const parentSids = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
      if (parentSids.length > 0) {
        const pid = parentSids[0];
        const arr = commitsByParent.get(pid) || [];
        arr.push(c);
        commitsByParent.set(pid, arr);
      } else {
        orphanCommits.push(c);
      }
    }

    for (const [pid, pCommits] of commitsByParent) {
      const parentPos = allPositions[pid];
      if (!parentPos) continue;
      const sortedC = [...pCommits].sort((a, b) =>
        new Date(a.date).getTime() - new Date(b.date).getTime()
      );
      for (let i = 0; i < sortedC.length; i++) {
        const col = i % COMMIT_COLS;
        const row = Math.floor(i / COMMIT_COLS);
        nodeList.push({
          id: `commit:${shortHash(sortedC[i].hash)}`,
          type: "commit",
          x: parentPos.x + config.commitOffsetX + col * (COMMIT_W + 8),
          y: parentPos.y + NODE_H + 14 + row * (COMMIT_H + 6),
          col, row,
          commit: sortedC[i],
          dayKey: dayKey(new Date(sortedC[i].date).getTime()),
        });
      }
    }

    // Orphan commits: nearest session in time
    for (const c of orphanCommits) {
      const ct = new Date(c.date).getTime();
      let bestSid: string | null = null;
      let bestDist = Infinity;
      for (const s of sorted) {
        const dist = Math.abs(s.created_at - ct);
        if (dist < bestDist && allPositions[s.id]) { bestDist = dist; bestSid = s.id; }
      }
      if (bestSid && allPositions[bestSid]) {
        const sp = allPositions[bestSid];
        const existing = nodeList.filter(
          n => n.type === "commit" && Math.abs(n.x - sp.x) < NODE_W * 2 && Math.abs(n.y - (sp.y + NODE_H)) < 100,
        );
        const idx = existing.length;
        const col = idx % COMMIT_COLS;
        const row = Math.floor(idx / COMMIT_COLS);
        nodeList.push({
          id: `commit:${shortHash(c.hash)}`,
          type: "commit",
          x: sp.x + config.commitOffsetX + col * (COMMIT_W + 8),
          y: sp.y + NODE_H + 14 + row * (COMMIT_H + 6),
          col, row, commit: c,
          dayKey: dayKey(ct),
        });
      }
    }

    // Document nodes — midpoint between linked sessions
    const nodeMapLocal = new Map(nodeList.map(n => [n.id, n]));
    for (const doc of handoffDocs) {
      const fromNode = nodeMapLocal.get(doc.fromSessionId);
      const toNode = nodeMapLocal.get(doc.toSessionId);
      if (!fromNode || !toNode) continue;
      nodeList.push({
        id: `doc:${doc.moveRunId}`,
        type: "document",
        x: (fromNode.x + NODE_W / 2 + toNode.x + NODE_W / 2) / 2 - DOC_W / 2,
        y: (fromNode.y + NODE_H / 2 + toNode.y + NODE_H / 2) / 2 - DOC_H / 2,
        col: fromNode.col, row: fromNode.row,
        doc,
      });
    }

    // Build day clusters from actual positions
    const dayGroups = new Map<string, GraphNode[]>();
    for (const n of nodeList) {
      const dk = n.dayKey ?? (n.commit ? dayKey(new Date(n.commit.date).getTime()) : null);
      if (!dk) continue;
      const arr = dayGroups.get(dk) || [];
      arr.push(n);
      dayGroups.set(dk, arr);
    }

    const clusterList: TimeCluster[] = [];
    const sortedDays = [...dayGroups.keys()].sort();
    for (let di = 0; di < sortedDays.length; di++) {
      const dk = sortedDays[di];
      const dayNodes = dayGroups.get(dk)!;
      let minX = Infinity, maxX = -Infinity;
      let sessionCount = 0, commitCount = 0;
      for (const n of dayNodes) {
        const w = n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W;
        if (n.x < minX) minX = n.x;
        if (n.x + w > maxX) maxX = n.x + w;
        if (n.type === "session") sessionCount++;
        if (n.type === "commit") commitCount++;
      }
      clusterList.push({
        id: `cluster:${di}`,
        label: dayKey(Date.now()) === dk ? "today" : dk,
        x: minX - 24,
        width: (maxX - minX) + 48,
        sessionCount, commitCount,
      });
    }

    return { nodes: nodeList, clusters: clusterList };
  }, [filteredSessions, solvedPositions, storedPositions, dragPreview, handoffDocs,
      commitSessionMap, spawnedSet, commits, config]);

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const visibleEdges = useMemo(() => {
    const MAX_TOUCH_EDGE_DIST = 900;
    return edges.filter(e => {
      if (e.type === "document") return edgeLayers.handoff;
      if (e.type in edgeLayers && !edgeLayers[e.type as keyof EdgeLayers]) return false;
      if (e.type === "co-edit" || e.type === "co-read") {
        const fromN = nodeMap.get(e.from);
        const toN = nodeMap.get(e.to);
        if (fromN && toN) {
          const dist = Math.hypot(fromN.x - toN.x, fromN.y - toN.y);
          if (dist > MAX_TOUCH_EDGE_DIST) return false;
        }
      }
      return true;
    });
  }, [edges, edgeLayers, nodeMap]);

  const newestSessionNode = useMemo(() => {
    return nodes
      .filter((n): n is GraphNode & { type: "session"; session: SessionInfo } => n.type === "session" && !!n.session)
      .sort((a, b) => {
        const timeDiff = (a.session?.created_at ?? 0) - (b.session?.created_at ?? 0);
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      })
      .at(-1) ?? null;
  }, [nodes]);

  // ── Derived from debounced culling state ──
  const currentDayCluster = useMemo(() => {
    if (!clusters.length) return null;
    const canvasCenterX = (cullingState.left + cullingState.right) / 2;
    const containing = clusters.find(cl => canvasCenterX >= cl.x && canvasCenterX <= cl.x + cl.width);
    if (containing) return containing;
    return clusters.reduce((best, cl) => {
      const clCenter = cl.x + cl.width / 2;
      const bestCenter = best.x + best.width / 2;
      return Math.abs(clCenter - canvasCenterX) < Math.abs(bestCenter - canvasCenterX) ? cl : best;
    });
  }, [clusters, cullingState]);

  const svgW = useMemo(() => {
    const maxX = Math.max(...nodes.map(n => n.x + nodeDims(n.type).w), 400);
    return maxX + config.padX;
  }, [nodes, config.padX]);

  const svgH = useMemo(() => {
    const maxY = Math.max(...nodes.map(n => n.y + nodeDims(n.type).h), 300);
    return maxY + config.padY;
  }, [nodes, config.padY]);

  // Keep refs in sync for applyViewport's minimap update
  svgWRef.current = svgW;
  svgHRef.current = svgH;

  // ── Frustum culling: driven by debounced culling state, not live viewport ──
  const visibleNodes = useMemo(() => {
    return nodes.filter(n => {
      const { w, h } = nodeDims(n.type);
      return n.x + w > cullingState.left && n.x < cullingState.right
          && n.y + h > cullingState.top  && n.y < cullingState.bottom;
    });
  }, [nodes, cullingState]);

  const lodSimplified = cullingState.scale < 0.25;

  // ── Wheel zoom ──
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
      const vp = viewportRef.current;
      const s = Math.max(0.15, Math.min(4, vp.scale * factor));
      const r = s / vp.scale;
      applyViewport({ scale: s, x: mx - r * (mx - vp.x), y: my - r * (my - vp.y) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loading]);

  // ── Pan handlers ──
  const onPanStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (nodeDragRef.current) return;
    if (e.shiftKey) {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const vp = viewportRef.current;
      const canvasX = (e.clientX - rect.left - vp.x) / vp.scale;
      const canvasY = (e.clientY - rect.top - vp.y) / vp.scale;
      lassoRef.current = { startClientX: e.clientX, startClientY: e.clientY, startCanvasX: canvasX, startCanvasY: canvasY };
      return;
    }
    const vp = viewportRef.current;
    dragRef.current = { startX: e.clientX, startY: e.clientY, vpX: vp.x, vpY: vp.y, hasMoved: false };
  };

  const onPanMove = (e: React.MouseEvent) => {
    if (lassoRef.current) {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const vp = viewportRef.current;
      const canvasX = (e.clientX - rect.left - vp.x) / vp.scale;
      const canvasY = (e.clientY - rect.top - vp.y) / vp.scale;
      const lasso = lassoRef.current;
      setLassoRect({
        x: Math.min(lasso.startCanvasX, canvasX),
        y: Math.min(lasso.startCanvasY, canvasY),
        w: Math.abs(canvasX - lasso.startCanvasX),
        h: Math.abs(canvasY - lasso.startCanvasY),
      });
      return;
    }

    if (nodeDragRef.current) {
      const nd = nodeDragRef.current;
      const vp = viewportRef.current;
      const dx = (e.clientX - nd.startX) / vp.scale;
      const dy = (e.clientY - nd.startY) / vp.scale;
      if (!nd.hasMoved && Math.hypot(dx, dy) > 3) nd.hasMoved = true;
      if (nd.hasMoved) {
        if (nd.chainIds.length > 1) {
          // Multi-drag: move all selected nodes by same delta
          const updates: PositionMap = {};
          for (const id of nd.chainIds) {
            const orig = nd.origPositions[id];
            if (orig) updates[id] = { x: orig.x + dx, y: orig.y + dy };
          }
          setDragPreview(updates);
        } else {
          const dragX = nd.origX + dx;
          const dragY = nd.origY + dy;
          const MARGIN = 16;
          // Dragged node is in preview so storedPositions never mutates during drag
          const preview: PositionMap = { [nd.nodeId]: { x: dragX, y: dragY } };
          const nearby = nodes.filter(n => n.id !== nd.nodeId && n.type === "session");
          const getBase = (n: GraphNode) => storedPositions[n.id] ?? { x: n.x, y: n.y };
          const pushed = new Set<string>();
          for (const n of nearby) {
            const p = getBase(n);
            const overlapX = (NODE_W + MARGIN) - Math.abs(dragX - p.x);
            const overlapY = (NODE_H + MARGIN) - Math.abs(dragY - p.y);
            if (overlapX > 0 && overlapY > 0) {
              if (overlapY <= overlapX + 20) {
                preview[n.id] = { x: p.x, y: p.y + (p.y >= dragY ? overlapY : -overlapY) };
              } else {
                preview[n.id] = { x: p.x + (p.x >= dragX ? overlapX : -overlapX), y: p.y };
              }
              pushed.add(n.id);
            }
          }
          for (const pid of pushed) {
            const pp = preview[pid]!;
            for (const n of nearby) {
              if (n.id === pid || pushed.has(n.id)) continue;
              const p = getBase(n);
              const overlapX = (NODE_W + MARGIN) - Math.abs(pp.x - p.x);
              const overlapY = (NODE_H + MARGIN) - Math.abs(pp.y - p.y);
              if (overlapX > 0 && overlapY > 0) {
                if (overlapY <= overlapX + 20) {
                  preview[n.id] = { x: p.x, y: p.y + (p.y >= pp.y ? overlapY : -overlapY) };
                } else {
                  preview[n.id] = { x: p.x + (p.x >= pp.x ? overlapX : -overlapX), y: p.y };
                }
              }
            }
          }
          setDragPreview(preview);
        }
      }
      return;
    }

    if (mmDragRef.current) return;

    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!dragRef.current.hasMoved && Math.hypot(dx, dy) > 5) dragRef.current.hasMoved = true;
    const newX = dragRef.current.vpX + dx;
    const newY = dragRef.current.vpY + dy;
    const wrap = wrapRef.current;
    if (wrap) {
      const vp = viewportRef.current;
      const minX = -(svgW * vp.scale - 100);
      const minY = -(svgH * vp.scale - 100);
      const maxX = wrap.clientWidth - 100;
      const maxY = wrap.clientHeight - 100;
      applyViewport({ ...vp, x: Math.max(minX, Math.min(maxX, newX)), y: Math.max(minY, Math.min(maxY, newY)) });
    } else {
      const vp = viewportRef.current;
      applyViewport({ ...vp, x: newX, y: newY });
    }
  };

  const onPanEnd = () => {
    if (lassoRef.current) {
      setLassoRect(prev => {
        if (prev && prev.w > 5 && prev.h > 5) {
          const newSelected = new Set<string>();
          for (const n of nodes) {
            const { w, h } = nodeDims(n.type);
            if (n.x + w > prev.x && n.x < prev.x + prev.w &&
                n.y + h > prev.y && n.y < prev.y + prev.h) {
              newSelected.add(n.id);
            }
          }
          if (newSelected.size > 0) setSelectedIds(newSelected);
        }
        return null;
      });
      lassoRef.current = null;
      return;
    }

    if (nodeDragRef.current?.hasMoved) {
      const dragNode = nodeDragRef.current;
      // dragPreview holds all moved positions (dragged node + any pushed neighbors)
      const capturedPreview = { ...dragPreview };
      const changed: { nodeId: string; x: number; y: number; pinned: boolean }[] = [];
      setStoredPositions(prev => {
        const next = { ...prev, ...capturedPreview };
        for (const id of Object.keys(capturedPreview)) {
          if (next[id]) changed.push({ nodeId: id, x: next[id].x, y: next[id].y, pinned: id === dragNode.nodeId });
        }
        patchWebPositions(profileName, changed);
        return next;
      });
      setDragPreview({});
    } else if (dragRef.current && !dragRef.current.hasMoved) {
      // Clicked empty canvas — deselect all
      setSelectedIds(new Set());
    }

    nodeDragRef.current = null;
    dragRef.current = null;
    setDraggingChain(null);
  };

  // ── Touch handlers ──
  const onTouchStart = (e: React.TouchEvent) => {
    const vp = viewportRef.current;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, vpX: vp.x, vpY: vp.y, hasMoved: false };
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      touchRef.current = {
        startX: (t1.clientX + t2.clientX) / 2, startY: (t1.clientY + t2.clientY) / 2,
        vpX: vp.x, vpY: vp.y, initialDistance: dist, initialScale: vp.scale, hasMoved: true,
      };
    }
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchRef.current) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const dx = touch.clientX - touchRef.current.startX;
      const dy = touch.clientY - touchRef.current.startY;
      if (!touchRef.current.hasMoved && Math.hypot(dx, dy) > 5) touchRef.current.hasMoved = true;
      const newX = touchRef.current.vpX + dx;
      const newY = touchRef.current.vpY + dy;
      const vp = viewportRef.current;
      const minX = -(svgW * vp.scale - 100);
      const minY = -(svgH * vp.scale - 100);
      const maxX = wrap.clientWidth - 100;
      const maxY = wrap.clientHeight - 100;
      applyViewport({ ...vp, x: Math.max(minX, Math.min(maxX, newX)), y: Math.max(minY, Math.min(maxY, newY)) });
    } else if (e.touches.length === 2 && touchRef.current.initialDistance && touchRef.current.initialScale) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const ratio = dist / touchRef.current.initialDistance;
      const rect = wrap.getBoundingClientRect();
      const mx = (t1.clientX + t2.clientX) / 2 - rect.left;
      const my = (t1.clientY + t2.clientY) / 2 - rect.top;
      const vp = viewportRef.current;
      const s = Math.max(0.15, Math.min(4, touchRef.current.initialScale * ratio));
      const r = s / vp.scale;
      applyViewport({ scale: s, x: mx - r * (mx - vp.x), y: my - r * (my - vp.y) });
    }
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const vp = viewportRef.current;
    if (e.touches.length === 0) touchRef.current = null;
    else if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, vpX: vp.x, vpY: vp.y };
    }
  };

  // ── Node interaction callbacks (stable references for memoized components) ──
  const onNodeDragStart = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== "session") return;
    const isGroupDrag = selectedIds.has(nodeId) && selectedIds.size > 1;
    const ids = isGroupDrag
      ? [...selectedIds].filter(id => nodeMap.get(id)?.type === "session")
      : [nodeId];
    const origPositions: Record<string, { x: number; y: number }> = {};
    for (const id of ids) {
      const n = nodeMap.get(id);
      if (n) origPositions[id] = { x: n.x, y: n.y };
    }
    setDraggingChain(new Set(ids));
    nodeDragRef.current = {
      nodeId, startX: e.clientX, startY: e.clientY,
      origX: node.x, origY: node.y, chainIds: ids, origPositions, hasMoved: false,
    };
  }, [nodeMap, selectedIds]);

  const handleSelect = useCallback((node: GraphNode, e?: React.MouseEvent) => {
    if (dragRef.current?.hasMoved || touchRef.current?.hasMoved || nodeDragRef.current?.hasMoved) return;
    if (e?.shiftKey) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(node.id)) next.delete(node.id);
        else next.add(node.id);
        return next;
      });
    } else {
      setSelectedIds(prev => prev.size === 1 && prev.has(node.id) ? new Set() : new Set([node.id]));
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind: "session", x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handlePinToggle = useCallback(async (id: string) => {
    const session = sessions.find(s => s.id === id);
    const currentTags = parseTags(session?.tags ?? "");
    const isPinned = currentTags.includes("pinned");
    setSessions(prev => prev.map(s => {
      if (s.id !== id) return s;
      const tags = parseTags(s.tags);
      const newTags = isPinned ? tags.filter(t => t !== "pinned") : [...tags, "pinned"];
      return { ...s, tags: JSON.stringify(newTags) };
    }));
    setContextMenu(null);
    if (isPinned) {
      await removeSessionTagApi(id, "pinned").catch(() => {});
    } else {
      await addSessionTagApi(id, "pinned").catch(() => {});
    }
  }, [sessions]);

  const handleArchive = useCallback(async (id: string) => {
    await archiveSessionApi(id).catch(() => {});
    setSessions(prev => prev.filter(s => s.id !== id));
    setSelectedIds(new Set());
    setContextMenu(null);
    setStoredPositions(prev => {
      const next = { ...prev };
      delete next[id];
      // Position will be ignored since the session is archived — no need to delete from DB
      return next;
    });
  }, [profileName]);

  const handleCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const vp = viewportRef.current;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const canvasX = (e.clientX - rect.left - vp.x) / vp.scale;
    const canvasY = (e.clientY - rect.top - vp.y) / vp.scale;
    setContextMenu({ kind: "canvas", x: e.clientX, y: e.clientY, canvasX, canvasY });
  }, []);

  const reloadData = useCallback(async () => {
    const projectCwd = activeUP?.projects?.[0];
    const [sessData, moveData, touchData] = await Promise.all([
      fetchSessionsScoped(500, activeUserProfile ?? undefined),
      fetch(`${API_BASE}/api/move-runs/recent?limit=200`, { headers: authHeaders() }).then(r => r.json()),
      fetchTouches({
        userProfile: activeUserProfile ?? undefined,
        cwd: projectCwd ?? undefined,
        ops: ["write", "edit", "read"],
        limit: 5000,
      }).catch(() => ({ touches: [] as TouchRecord[], summary: {} })),
    ]);
    setSessions(sessData);
    setMoveRuns(moveData);
    setTouches(touchData.touches);
  }, [activeUserProfile, activeUP]);

  // ── Global SSE: real-time session lifecycle events ──
  useEffect(() => {
    const token = localStorage.getItem("harness_token") || "";
    const url = `${API_BASE}/api/events/sessions${token ? `?token=${token}` : ""}`;
    const es = new EventSource(url);

    es.addEventListener("session", (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === "session:created") {
          reloadData();
        } else if (evt.type === "session:status") {
          setSessions(prev => prev.map(s =>
            s.id === evt.sessionId
              ? { ...s, status: evt.status, total_cost_usd: evt.costUsd ?? s.total_cost_usd, preview: evt.preview ?? s.preview }
              : s,
          ));
        } else if (evt.type === "session:archived") {
          setSessions(prev => prev.filter(s => s.id !== evt.sessionId));
          setStoredPositions(prev => {
            const next = { ...prev };
            delete next[evt.sessionId];
            return next;
          });
        }
      } catch { /* ignore malformed events */ }
    });

    es.onerror = () => {
      // EventSource auto-reconnects — no action needed
    };

    return () => es.close();
  }, [reloadData]);

  const handleCanvasDoubleClick = useCallback(async (e: React.MouseEvent) => {
    // Only trigger on actual canvas background, not on nodes
    if ((e.target as HTMLElement).closest(".web-session-node, .web-commit-node, .web-doc-node")) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const v = viewportRef.current;
    const canvasX = (e.clientX - rect.left - v.x) / v.scale;
    const canvasY = (e.clientY - rect.top - v.y) / v.scale;

    try {
      const projectCwd = activeUP?.projects?.[0];
      const sessionId = await createEmptySession({
        profile: activeUserProfile ?? undefined,
        userProfile: activeUserProfile ?? undefined,
        cwd: projectCwd ?? undefined,
      });
      // Pin the new node at the click position
      const pos = { x: canvasX, y: canvasY };
      setStoredPositions(prev => ({ ...prev, [sessionId]: pos }));
      patchWebPositions(profileName, [{ nodeId: sessionId, ...pos, pinned: true }]);
      await reloadData();
      setComposerState({ x: canvasX, y: canvasY, sessionId });
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [activeUserProfile, activeUP, profileName, reloadData]);

  const handleNewSession = useCallback(async (profile?: string) => {
    setContextMenu(null);
    const projectCwd = activeUP?.projects?.[0];
    try {
      await createSession({
        prompt: "",
        profile,
        userProfile: activeUserProfile ?? undefined,
        cwd: projectCwd ?? undefined,
      });
      await reloadData();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, [activeUserProfile, activeUP, reloadData]);

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard.writeText(id).catch(() => {});
    setContextMenu(null);
  }, []);

  const handleResetView = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !newestSessionNode) {
      applyViewport({ x: config.padX, y: config.padY, scale: 1 });
      return;
    }
    const targetX = newestSessionNode.x + NODE_W / 2;
    const targetY = newestSessionNode.y + NODE_H / 2;
    applyViewport({ x: wrap.clientWidth / 2 - targetX, y: wrap.clientHeight / 2 - targetY, scale: 1 });
  }, [newestSessionNode, config.padX, config.padY]);

  const onOpenSession = useCallback((id: string) => setMiniSessionId(id), []);
  const onOpenFile = useCallback((path: string) => setFileViewerPath(path), []);
  const onHover = useCallback((id: string | null) => setHoveredId(id), []);

  const onNodeTouchEnd = useCallback((nodeId: string, doubleAction: () => void) => {
    if (touchRef.current?.hasMoved) return;
    const now = Date.now();
    if (lastTapRef.current?.id === nodeId && now - lastTapRef.current.time < 300) {
      doubleAction();
      lastTapRef.current = null;
    } else {
      lastTapRef.current = { id: nodeId, time: now };
    }
  }, []);

  // ── Auto-center on newest session ──
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

  // ── Derived state ──
  const selectedNode = selectedIds.size === 1 ? (nodeMap.get([...selectedIds][0]) ?? null) : null;

  const neighborIds = useMemo(() => {
    if (!selectedNode) return new Set<string>();
    const s = new Set<string>();
    for (const e of visibleEdges) {
      if (e.from === selectedNode.id) s.add(e.to);
      if (e.to === selectedNode.id) s.add(e.from);
    }
    return s;
  }, [selectedNode, visibleEdges]);

  const activeEdgeSet = useMemo(() => {
    const hovered = hoveredId ? new Set([hoveredId]) : null;
    const active = hovered ?? (selectedIds.size > 0 ? selectedIds : null);
    if (!active) return new Set<string>();
    const s = new Set<string>();
    for (const e of visibleEdges) {
      if (active.has(e.from) || active.has(e.to)) s.add(`${e.from}->${e.to}`);
    }
    return s;
  }, [hoveredId, selectedIds, visibleEdges]);

  // ── Render ──

  if (loading) {
    return <div className="web-panel"><div className="web-empty">loading...</div></div>;
  }

  if (nodes.length === 0) {
    return (
      <div className="web-panel">
        <div className="web-empty">no sessions found{dateFilter.startDate || dateFilter.endDate ? " in date range" : ""}</div>
        {(dateFilter.startDate || dateFilter.endDate) && (
          <div className="web-toolbar"><DateFilterPanel filter={dateFilter} onChange={setDateFilter} /></div>
        )}
      </div>
    );
  }

  const vp = viewportRef.current;

  return (
    <div className="web-panel">
      <div className="web-toolbar" onMouseDown={e => e.stopPropagation()}>
        <DateFilterPanel filter={dateFilter} onChange={setDateFilter} />
        <button
          className="web-regen-btn"
          onClick={async () => {
            // 1. Gate the solver so it doesn't fire with stale/empty positions
            setPositionsLoaded(false);
            setStoredPositions({});
            // 2. Delete all positions from backend for this scope
            await fetch(`${API_BASE}/api/web/positions?scope=${encodeURIComponent(profileName)}`, {
              method: "DELETE", headers: authHeaders(),
            });
            // 3. Re-open the gate — solver will now run with empty storedPositions
            //    and solve all sessions fresh, then persist via the useEffect
            setPositionsLoaded(true);
          }}
        >regenerate</button>
        {minimapTags.length > 0 && (
          <div className="web-mm-tags">
            {minimapTags.map(tag => (
              <div key={tag.id} className="web-toolbar-tag">
                <span onClick={() => {
                  const wrap = wrapRef.current;
                  const vp = viewportRef.current;
                  if (wrap) {
                    applyViewport({
                      ...vp,
                      x: -(tag.x * vp.scale) + wrap.clientWidth / 2,
                      y: -(tag.y * vp.scale) + wrap.clientHeight / 2,
                    });
                  }
                }}>{tag.label}</span>
                <button className="web-toolbar-tag-x" onClick={e => {
                  e.stopPropagation();
                  setMinimapTags(prev => {
                    const next = prev.filter(t => t.id !== tag.id);
                    localStorage.setItem(`web-mm-tags-${profileName}`, JSON.stringify(next));
                    return next;
                  });
                }}>×</button>
              </div>
            ))}
          </div>
        )}
        <EdgeLayerPanel layers={edgeLayers} onChange={setEdgeLayers} />
      </div>

      <div
        className="web-canvas-wrap"
        ref={wrapRef}
        onContextMenu={handleCanvasContextMenu}
        onDoubleClick={handleCanvasDoubleClick}
        onMouseDown={onPanStart}
        onMouseMove={onPanMove}
        onMouseUp={onPanEnd}
        onMouseLeave={onPanEnd}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          ref={canvasRef}
          className={`web-canvas${vp.scale < 0.4 ? " web-canvas--zoomed-out" : ""}`}
          style={{ width: svgW, height: svgH, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})` }}
        >
          {clusters.map(cl => (
            <div key={cl.id} className="web-window" style={{ left: cl.x, top: 0, width: cl.width, height: svgH }}>
              <div className="web-window-header">
                <span className="web-window-label">{cl.label}</span>
                <span className="web-window-count">
                  {cl.sessionCount}{cl.commitCount > 0 ? ` · ${cl.commitCount}c` : ""}
                </span>
              </div>
            </div>
          ))}

          <svg className="web-svg" width={svgW} height={svgH}>
            {visibleEdges.map((e, i) => {
              const from = nodeMap.get(e.from);
              const to = nodeMap.get(e.to);
              if (!from || !to) return null;
              const edgeKey = `${e.from}->${e.to}`;
              const active = activeEdgeSet.has(edgeKey);
              return (
                <g key={i} className={active ? "web-edge-active" : ""}>
                  <EdgePath from={from} to={to} type={e.type} lane={e.lane} />
                </g>
              );
            })}
          </svg>

          {lassoRect && (
            <div
              className="web-lasso"
              style={{ left: lassoRect.x, top: lassoRect.y, width: lassoRect.w, height: lassoRect.h }}
            />
          )}

          {visibleNodes.map(node => {
            // LOD: simplified rendering at very low zoom
            if (lodSimplified) {
              const { w, h } = nodeDims(node.type);
              const isRunning = node.type === "session" && node.session?.status === "running";
              const bg = node.type === "session"
                ? (isRunning ? "var(--success)" : node.session?.status === "error" ? "var(--error)" : "var(--text-muted)")
                : node.type === "commit" ? "var(--info)" : "var(--text-muted)";
              return (
                <div
                  key={node.id}
                  className={isRunning ? "web-lod-running" : undefined}
                  style={{
                    position: "absolute", left: node.x, top: node.y,
                    width: w, height: h,
                    background: bg, opacity: node.type === "session" ? 0.5 : 0.25,
                    borderRadius: 3, pointerEvents: "none",
                  }}
                />
              );
            }

            if (node.type === "document" && node.doc) {
              return (
                <DocNodeEl
                  key={node.id}
                  node={node}
                  isSelected={selectedIds.has(node.id)}
                  isNeighbor={neighborIds.has(node.id)}
                  onSelect={handleSelect}
                  onOpenFile={onOpenFile}
                  onHover={onHover}
                  onNodeTouchEnd={onNodeTouchEnd}
                />
              );
            }

            if (node.type === "commit") {
              return (
                <CommitNodeEl
                  key={node.id}
                  node={node}
                  isSelected={selectedIds.has(node.id)}
                  isNeighbor={neighborIds.has(node.id)}
                  onSelect={handleSelect}
                  onHover={onHover}
                />
              );
            }

            return (
              <SessionNodeEl
                key={node.id}
                node={node}
                isSelected={selectedIds.has(node.id)}
                isNeighbor={neighborIds.has(node.id)}
                isDragging={draggingChain?.has(node.id) ?? false}
                touchCounts={sessionTouchCounts.get(node.session!.id)}
                onSelect={handleSelect}
                onOpen={onOpenSession}
                onDragStart={onNodeDragStart}
                onContextMenu={handleContextMenu}
                onHover={onHover}
                onNodeTouchEnd={onNodeTouchEnd}
              />
            );
          })}

          {composerState && (
            <WebComposer
              sessionId={composerState.sessionId}
              x={composerState.x}
              y={composerState.y}
              onClose={() => setComposerState(null)}
              onSent={reloadData}
              onMove={(nx, ny) => {
                setComposerState(prev => prev ? { ...prev, x: nx, y: ny } : null);
                // Also update the session node position to match
                setStoredPositions(prev => ({ ...prev, [composerState.sessionId]: { x: nx, y: ny } }));
                patchWebPositions(profileName, [{ nodeId: composerState.sessionId, x: nx, y: ny, pinned: true }]);
              }}
            />
          )}
        </div>

        <button
          className="web-reset-btn"
          onMouseDown={e => e.stopPropagation()}
          onClick={handleResetView}
          title="Reset view"
        >⊙</button>

        {currentDayCluster && (
          <div className="web-day-hud">
            <span className="web-day-hud-label">{currentDayCluster.label}</span>
            <span className="web-day-hud-stats">
              {currentDayCluster.sessionCount} sessions{currentDayCluster.commitCount > 0 ? ` · ${currentDayCluster.commitCount}c` : ""}
            </span>
          </div>
        )}

        {/* Minimap */}
        {nodes.length > 0 && (() => {
          const mmH = 80;
          const mmW = wrapRef.current?.clientWidth ?? 800;
          const scaleX = mmW / svgW;
          const scaleY = mmH / svgH;
          const vpW = wrapRef.current?.clientWidth ?? 800;
          const vpH = wrapRef.current?.clientHeight ?? 600;
          const vrX = Math.max(0, (-vp.x / vp.scale) * scaleX);
          const vrY = Math.max(0, (-vp.y / vp.scale) * scaleY);
          const vrW = Math.min(mmW - vrX, (vpW / vp.scale) * scaleX);
          const vrH = Math.min(mmH - vrY, (vpH / vp.scale) * scaleY);
          return (
            <div
              className="web-minimap"
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const curScaleX = (wrapRef.current?.clientWidth ?? 800) / svgW;
                const curScaleY = mmH / svgH;
                const canvasX = (e.clientX - rect.left) / curScaleX;
                const canvasY = (e.clientY - rect.top) / curScaleY;
                const label = `pin ${minimapTags.length + 1}`;
                const newTag: MinimapTag = { id: crypto.randomUUID(), label, x: canvasX, y: canvasY };
                setMinimapTags(prev => {
                  const next = [...prev, newTag];
                  localStorage.setItem(`web-mm-tags-${profileName}`, JSON.stringify(next));
                  return next;
                });
              }}
              onMouseDown={e => {
                e.stopPropagation();
                const startX = e.clientX;
                const startY = e.clientY;
                const mmEl = e.currentTarget as HTMLElement;
                const rect = mmEl.getBoundingClientRect();
                const curScaleX = (wrapRef.current?.clientWidth ?? 800) / svgW;
                const curScaleY = mmH / svgH;
                const curVpW = wrapRef.current?.clientWidth ?? 800;
                const curVpH = wrapRef.current?.clientHeight ?? 600;
                const curVp = viewportRef.current;

                const mx = (e.clientX - rect.left) / curScaleX;
                const my = (e.clientY - rect.top) / curScaleY;
                const jumpVpX = -(mx - curVpW / (2 * curVp.scale)) * curVp.scale;
                const jumpVpY = -(my - curVpH / (2 * curVp.scale)) * curVp.scale;
                applyViewport({ ...curVp, x: jumpVpX, y: jumpVpY });

                mmDragRef.current = { startX, startY, startVpX: jumpVpX, startVpY: jumpVpY, hasMoved: false };

                const onMove = (ev: MouseEvent) => {
                  const dx = ev.clientX - startX;
                  const dy = ev.clientY - startY;
                  if (Math.hypot(dx, dy) > 3) mmDragRef.current!.hasMoved = true;
                  const wrap = wrapRef.current;
                  if (wrap) {
                    const liveVp = viewportRef.current;
                    const minX = -(svgWRef.current * liveVp.scale - 100);
                    const maxX = wrap.clientWidth - 100;
                    const minY = -(svgHRef.current * liveVp.scale - 100);
                    const maxY = wrap.clientHeight - 100;
                    applyViewport({
                      ...liveVp,
                      x: Math.max(minX, Math.min(maxX, jumpVpX - (dx / curScaleX) * liveVp.scale)),
                      y: Math.max(minY, Math.min(maxY, jumpVpY - (dy / curScaleY) * liveVp.scale)),
                    });
                  }
                };
                const onUp = () => {
                  window.removeEventListener("mousemove", onMove);
                  window.removeEventListener("mouseup", onUp);
                  mmDragRef.current = null;
                };
                window.addEventListener("mousemove", onMove);
                window.addEventListener("mouseup", onUp);
              }}
              onTouchStart={e => {
                e.stopPropagation();
                if (e.touches.length !== 1) return;
                const touch = e.touches[0];
                const rect = e.currentTarget.getBoundingClientRect();
                const wrap = wrapRef.current;
                const curScaleX = (wrap?.clientWidth ?? 800) / svgW;
                const curScaleY = mmH / svgH;
                const curVpW = wrap?.clientWidth ?? 800;
                const curVpH = wrap?.clientHeight ?? 600;
                const curVp = viewportRef.current;
                const mx = (touch.clientX - rect.left) / curScaleX;
                const my = (touch.clientY - rect.top) / curScaleY;
                const jumpVpX = -(mx - curVpW / (2 * curVp.scale)) * curVp.scale;
                const jumpVpY = -(my - curVpH / (2 * curVp.scale)) * curVp.scale;
                applyViewport({ ...curVp, x: jumpVpX, y: jumpVpY });
                mmDragRef.current = { startX: touch.clientX, startY: touch.clientY, startVpX: jumpVpX, startVpY: jumpVpY, hasMoved: false };
              }}
              onTouchMove={e => {
                e.stopPropagation();
                if (!mmDragRef.current || e.touches.length !== 1) return;
                const dx = e.touches[0].clientX - mmDragRef.current.startX;
                const dy = e.touches[0].clientY - mmDragRef.current.startY;
                if (Math.hypot(dx, dy) > 3) mmDragRef.current.hasMoved = true;
                const wrap = wrapRef.current;
                if (wrap) {
                  const curScaleX = wrap.clientWidth / svgW;
                  const curScaleY = mmH / svgH;
                  const liveVp = viewportRef.current;
                  const minX = -(svgWRef.current * liveVp.scale - 100);
                  const maxX = wrap.clientWidth - 100;
                  const minY = -(svgHRef.current * liveVp.scale - 100);
                  const maxY = wrap.clientHeight - 100;
                  applyViewport({
                    ...liveVp,
                    x: Math.max(minX, Math.min(maxX, mmDragRef.current!.startVpX - (dx / curScaleX) * liveVp.scale)),
                    y: Math.max(minY, Math.min(maxY, mmDragRef.current!.startVpY - (dy / curScaleY) * liveVp.scale)),
                  });
                }
              }}
              onTouchEnd={() => {
                mmDragRef.current = null;
              }}
            >
              <svg width={mmW} height={mmH}>
                {(() => {
                  const sorted = [...clusters].sort((a, b) => a.x - b.x);
                  let prevEnd = -Infinity;
                  const elements: React.ReactNode[] = [];
                  let idx = 0;
                  for (const cl of sorted) {
                    const bx = Math.max(cl.x, prevEnd);
                    const bw = cl.x + cl.width - bx;
                    prevEnd = cl.x + cl.width;
                    if (bw <= 0) continue;
                    const px = bx * scaleX;
                    elements.push(
                      <rect
                        key={`mm-band-${cl.id}`}
                        x={px} y={0}
                        width={bw * scaleX} height={mmH}
                        className={idx % 2 === 0 ? "web-mm-band" : "web-mm-band--alt"}
                      />
                    );
                    if (idx > 0) {
                      // faint full-height separator
                      elements.push(
                        <line key={`mm-sep-${cl.id}`} x1={px} y1={0} x2={px} y2={mmH}
                          stroke="rgba(255,255,255,0.03)" strokeWidth={1} />
                      );
                      // visible bottom tick
                      elements.push(
                        <line key={`mm-tick-${cl.id}`} x1={px} y1={mmH - 10} x2={px} y2={mmH}
                          stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
                      );
                    }
                    // day label at bottom
                    elements.push(
                      <text
                        key={`mm-lbl-${cl.id}`}
                        x={px + 3} y={mmH - 2}
                        className="web-mm-day-label"
                      >{cl.label}</text>
                    );
                    idx++;
                  }
                  return elements;
                })()}
                {nodes.map(n => {
                  const { w, h } = nodeDims(n.type);
                  const isSelected = selectedIds.has(n.id);
                  const cls = isSelected ? "web-mm-selected" : (n.type === "session"
                    ? (n.session?.status === "running" ? "web-mm-running" : "web-mm-session")
                    : n.type === "commit" ? "web-mm-commit" : "web-mm-doc");
                  return (
                    <rect
                      key={n.id}
                      x={n.x * scaleX} y={n.y * scaleY}
                      width={Math.max(w * scaleX, isSelected ? 3 : 2)} height={Math.max(h * scaleY, isSelected ? 2 : 1.5)}
                      className={cls}
                    />
                  );
                })}
                {minimapTags.map(tag => {
                  const px = tag.x * scaleX;
                  const py = tag.y * scaleY;
                  const r = 4;
                  return (
                    <polygon
                      key={tag.id}
                      points={`${px},${py - r} ${px + r},${py} ${px},${py + r} ${px - r},${py}`}
                      className="web-mm-pin"
                    />
                  );
                })}
                <rect
                  ref={mmRectRef}
                  x={vrX} y={vrY} width={vrW} height={vrH}
                  className="web-mm-viewport"
                />
              </svg>
            </div>
          );
        })()}

        <MissionFilterPanel runs={missionRuns} activeRunId={missionFilter} onChange={setMissionFilter} />
      </div>

      {contextMenu?.kind === "session" && (() => {
        const sess = sessions.find(s => s.id === contextMenu.sessionId);
        return sess ? (
          <SessionContextMenu
            x={contextMenu.x} y={contextMenu.y}
            session={sess}
            onCopyId={() => handleCopyId(contextMenu.sessionId)}
            onPinToggle={() => handlePinToggle(contextMenu.sessionId)}
            onArchive={() => handleArchive(contextMenu.sessionId)}
            onClose={() => setContextMenu(null)}
          />
        ) : null;
      })()}
      {contextMenu?.kind === "canvas" && (
        <CanvasContextMenu
          x={contextMenu.x} y={contextMenu.y}
          profiles={visibleProfiles.map(p => p.name)}
          onNewSession={handleNewSession}
          onClose={() => setContextMenu(null)}
        />
      )}

      {selectedNode && <DetailPanel node={selectedNode} onClose={() => setSelectedIds(new Set())} onArchive={handleArchive} onPinToggle={handlePinToggle} />}

      <SessionWindow
        sessionId={miniSessionId}
        onClose={() => setMiniSessionId(null)}
        onNavigate={id => {
          const profile = sessions.find(s => s.id === id)?.profile ?? "";
          window.location.hash = profile ? `${profile}/${id}` : id;
        }}
      />

      <ChatFileViewer path={fileViewerPath} onClose={() => setFileViewerPath(null)} />
    </div>
  );
}
