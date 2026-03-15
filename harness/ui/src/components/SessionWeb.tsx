import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import { fetchSessionsScoped } from "../api/sessions";
import { fetchGitLog } from "../api/git";
import { API_BASE, authHeaders } from "../api/_fetch";
import { fetchMissionRuns, fetchMissionTransfers, fetchMissionSessions } from "../api/missions";
import { fetchTouches } from "../api/trace";
import { archiveSessionApi } from "../api/sessions";
import type { SessionInfo, GitCommit } from "../api/types";
import type { MissionRunSummary, MissionTransferSummary } from "../api/missions";
import type { TouchRecord } from "../api/trace";
import { ChatFileViewer } from "./ChatFileViewer";
import { SessionWindow } from "./SessionWindow";
import { useProfiles } from "../providers/ProfileProvider";

import {
  type MoveRun,
  type GraphNode,
  type GraphEdge,
  type EdgeType,
  type EdgeLayers,
  type WebLayoutConfig,
  type PositionMap,
  type DateFilter,
  type TimeCluster,
  NODE_W, NODE_H, DOC_W, DOC_H, COMMIT_W, COMMIT_H,
  PAD_NODE_W, PAD_NODE_H,
  DEFAULT_CONFIG, PRESETS, DEFAULT_LAYERS,
  loadConfig, saveConfig,
  loadDateFilter, saveDateFilter,
  loadPositions, savePositions,
  loadLayers, saveLayers,
  shortId, shortHash, formatCost, timeAgo,
  parseTags,
  nodeBottom, nodeMidX, nodeRight, nodeMidY,
} from "./SessionWebLayout";

import { buildAllEdges } from "./SessionWebEdges";
import { solveLayout } from "./SessionWebSolver";

// ── Nearest-edge anchor point between two nodes ──

function nearestAnchor(
  n: GraphNode,
  targetX: number,
  targetY: number,
): { x: number; y: number } {
  const w = n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W;
  const h = n.type === "session" ? NODE_H : n.type === "document" ? DOC_H : COMMIT_H;
  const cx = n.x + w / 2;
  const cy = n.y + h / 2;
  const dx = targetX - cx;
  const dy = targetY - cy;
  // Which edge is closest to the target direction?
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
  // Compute connection points from nearest edge of each node toward the other's center
  const fromW = from.type === "session" ? NODE_W : from.type === "document" ? DOC_W : COMMIT_W;
  const fromH = from.type === "session" ? NODE_H : from.type === "document" ? DOC_H : COMMIT_H;
  const toW = to.type === "session" ? NODE_W : to.type === "document" ? DOC_W : COMMIT_W;
  const toH = to.type === "session" ? NODE_H : to.type === "document" ? DOC_H : COMMIT_H;
  const fromCx = from.x + fromW / 2, fromCy = from.y + fromH / 2;
  const toCx = to.x + toW / 2, toCy = to.y + toH / 2;

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

  // Handoff — smooth bezier
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  const cp = Math.min(Math.max(dist * 0.35, 20), dist * 0.45);
  // Bend toward the major axis
  if (Math.abs(dx) > Math.abs(dy)) {
    const d = `M ${p1.x} ${p1.y} C ${p1.x + (dx > 0 ? cp : -cp)} ${p1.y}, ${p2.x - (dx > 0 ? cp : -cp)} ${p2.y}, ${p2.x} ${p2.y}`;
    return <path d={d} className="web-edge web-edge--handoff" />;
  }
  const d = `M ${p1.x} ${p1.y} C ${p1.x} ${p1.y + (dy > 0 ? cp : -cp)}, ${p2.x} ${p2.y - (dy > 0 ? cp : -cp)}, ${p2.x} ${p2.y}`;
  return <path d={d} className="web-edge web-edge--handoff" />;
}

// ── Mission Filter Panel ──

function MissionFilterPanel({ runs, activeRunId, onChange }: {
  runs: MissionRunSummary[];
  activeRunId: number | null;
  onChange: (runId: number | null) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="web-mission-filter" onMouseDown={e => e.stopPropagation()}>
      <select
        value={activeRunId ?? ""}
        onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
      >
        <option value="">all missions</option>
        {runs.map(r => (
          <option key={r.id} value={r.id}>
            {r.missionName} #{r.id} ({r.status})
          </option>
        ))}
      </select>
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

function DetailPanel({ node, onClose, onArchive }: { node: GraphNode; onClose: () => void; onArchive?: (id: string) => void }) {
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
      {onArchive && (
        <button className="web-detail-archive" onClick={() => onArchive(s.id)}>
          archive
        </button>
      )}
    </div>
  );
}

// ── Context Menu ──

function ContextMenu({ x, y, onArchive, onClose }: {
  x: number;
  y: number;
  onArchive: () => void;
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
      <button onClick={onArchive}>archive</button>
    </div>
  );
}

// ── Main Component ──

type Viewport = { x: number; y: number; scale: number };

export function SessionWeb() {
  const { activeUserProfile, activeUP } = useProfiles();
  const profileName = activeUserProfile ?? "default";
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [moveRuns, setMoveRuns] = useState<MoveRun[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [missionRuns, setMissionRuns] = useState<MissionRunSummary[]>([]);
  const [missionTransfers, setMissionTransfers] = useState<MissionTransferSummary[]>([]);
  const [touches, setTouches] = useState<TouchRecord[]>([]);
  const [missionFilter, setMissionFilter] = useState<number | null>(null);
  const [missionFilterSessionIds, setMissionFilterSessionIds] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [fileViewerPath, setFileViewerPath] = useState<string | null>(null);
  const [miniSessionId, setMiniSessionId] = useState<string | null>(null);
  const [config, setConfig] = useState<WebLayoutConfig>(() => loadConfig());
  const [dateFilter, setDateFilter] = useState<DateFilter>(() => loadDateFilter(profileName));
  const [edgeLayers, setEdgeLayers] = useState<EdgeLayers>(() => loadLayers(profileName));
  const [positionOverrides, setPositionOverrides] = useState<PositionMap>(() => loadPositions(profileName));
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  const [draggingChain, setDraggingChain] = useState<Set<string> | null>(null);
  const [dragPreview, setDragPreview] = useState<PositionMap>({});

  const [viewport, setViewport] = useState<Viewport>(() => {
    const cfg = loadConfig();
    return { x: cfg.padX, y: cfg.padY, scale: 1 };
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; vpX: number; vpY: number; hasMoved?: boolean } | null>(null);
  const touchRef = useRef<{
    startX: number; startY: number; vpX: number; vpY: number;
    initialDistance?: number; initialScale?: number; hasMoved?: boolean;
  } | null>(null);
  const autoCenteredRef = useRef(false);
  const lastTapRef = useRef<{ id: string; time: number } | null>(null);
  const nodeDragRef = useRef<{
    nodeId: string; startX: number; startY: number;
    origX: number; origY: number; chainIds: string[]; hasMoved: boolean;
  } | null>(null);
  const mmDragRef = useRef<{ startX: number; startY: number; startVpX: number; startVpY: number; hasMoved: boolean } | null>(null);

  useEffect(() => { saveConfig(config); }, [config]);
  useEffect(() => { saveDateFilter(profileName, dateFilter); }, [dateFilter, profileName]);
  useEffect(() => { saveLayers(profileName, edgeLayers); }, [edgeLayers, profileName]);

  // Fetch all data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const projectCwd = activeUP?.projects?.[0];
        const [sessData, moveData, gitData, runsData, touchData] = await Promise.all([
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
        ]);
        if (cancelled) return;
        setSessions(sessData);
        setMoveRuns(moveData);
        setCommits(gitData);
        setMissionRuns(runsData);
        setTouches(touchData.touches);
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

  // Mission filter session IDs
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

  // Solver computes canonical positions — only re-runs on regenerate / data change
  const solverResult = useMemo(
    () => solveLayout(
      filteredSessions, edges, handoffDocs, commitSessionMap,
      childrenOf, spawnedSet, commits, config, undefined, touches,
    ),
    [filteredSessions, edges, handoffDocs, commitSessionMap, childrenOf, spawnedSet, commits, config, touches],
  );

  // Apply position overrides + ephemeral drag preview as simple coordinate replacements.
  // When a session moves, its attached commits and handoff docs follow.
  const { nodes, clusters } = useMemo(() => {
    const hasOverrides = Object.keys(positionOverrides).length > 0;
    const hasPreview = Object.keys(dragPreview).length > 0;
    if (!hasOverrides && !hasPreview) return solverResult;

    // Build a base-position map from solver result for delta computation
    const baseMap = new Map(solverResult.nodes.map(n => [n.id, { x: n.x, y: n.y }]));

    // Compute delta for each overridden session
    const sessionDeltas = new Map<string, { dx: number; dy: number }>();
    const merged: PositionMap = { ...positionOverrides, ...dragPreview };
    for (const [id, ov] of Object.entries(merged)) {
      const base = baseMap.get(id);
      if (base) sessionDeltas.set(id, { dx: ov.x - base.x, dy: ov.y - base.y });
    }

    // Map commit node IDs to parent session IDs
    const commitParent = new Map<string, string>();
    for (const [hash7, sids] of commitSessionMap) {
      if (sids.length > 0) commitParent.set(`commit:${hash7}`, sids[0]);
    }

    // Map doc node IDs to linked session IDs
    const docSessions = new Map<string, [string, string]>();
    for (const doc of handoffDocs) {
      docSessions.set(`doc:${doc.moveRunId}`, [doc.fromSessionId, doc.toSessionId]);
    }

    const patched = solverResult.nodes.map(n => {
      // Direct override on this node (session-level)
      const ov = dragPreview[n.id] ?? positionOverrides[n.id];
      if (ov) return { ...n, x: ov.x, y: ov.y };

      // Commit follows its parent session
      if (n.type === "commit") {
        const pid = commitParent.get(n.id);
        if (pid) {
          const d = sessionDeltas.get(pid);
          if (d) return { ...n, x: n.x + d.dx, y: n.y + d.dy };
        }
      }

      // Doc follows the average delta of its two linked sessions
      if (n.type === "document") {
        const pair = docSessions.get(n.id);
        if (pair) {
          const d1 = sessionDeltas.get(pair[0]);
          const d2 = sessionDeltas.get(pair[1]);
          if (d1 && d2) return { ...n, x: n.x + (d1.dx + d2.dx) / 2, y: n.y + (d1.dy + d2.dy) / 2 };
          if (d1) return { ...n, x: n.x + d1.dx, y: n.y + d1.dy };
          if (d2) return { ...n, x: n.x + d2.dx, y: n.y + d2.dy };
        }
      }

      return n;
    });
    return { nodes: patched, clusters: solverResult.clusters };
  }, [solverResult, positionOverrides, dragPreview, commitSessionMap, handoffDocs]);

  const nodeMap = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes]);

  const visibleEdges = useMemo(() => {
    const MAX_TOUCH_EDGE_DIST = 900;
    return edges.filter(e => {
      if (e.type === "document") return edgeLayers.handoff;
      if (e.type in edgeLayers && !edgeLayers[e.type as keyof EdgeLayers]) return false;
      // Hide co-edit/co-read edges that span too far — they're just noise
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

  const currentDayCluster = useMemo(() => {
    if (!clusters.length) return null;
    const vpW = wrapRef.current?.clientWidth ?? 800;
    const canvasCenterX = (vpW / 2 - viewport.x) / viewport.scale;
    const containing = clusters.find(cl => canvasCenterX >= cl.x && canvasCenterX <= cl.x + cl.width);
    if (containing) return containing;
    return clusters.reduce((best, cl) => {
      const clCenter = cl.x + cl.width / 2;
      const bestCenter = best.x + best.width / 2;
      return Math.abs(clCenter - canvasCenterX) < Math.abs(bestCenter - canvasCenterX) ? cl : best;
    });
  }, [clusters, viewport]);

  const svgW = useMemo(() => {
    const maxX = Math.max(...nodes.map(n => n.x + (n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W)), 400);
    return maxX + config.padX;
  }, [nodes, config.padX]);

  const svgH = useMemo(() => {
    const maxY = Math.max(...nodes.map(n => n.y + (n.type === "session" ? NODE_H : n.type === "document" ? DOC_H : COMMIT_H)), 300);
    return maxY + config.padY;
  }, [nodes, config.padY]);

  // Wheel zoom
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
      setViewport(vp => {
        const s = Math.max(0.15, Math.min(4, vp.scale * factor));
        const r = s / vp.scale;
        return { scale: s, x: mx - r * (mx - vp.x), y: my - r * (my - vp.y) };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [loading]);

  // Pan handlers
  const onPanStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (nodeDragRef.current) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, vpX: viewport.x, vpY: viewport.y, hasMoved: false };
  };
  const onPanMove = (e: React.MouseEvent) => {
    if (nodeDragRef.current) {
      const nd = nodeDragRef.current;
      const dx = (e.clientX - nd.startX) / viewport.scale;
      const dy = (e.clientY - nd.startY) / viewport.scale;
      if (!nd.hasMoved && Math.hypot(dx, dy) > 3) nd.hasMoved = true;
      if (nd.hasMoved) {
        const dragX = nd.origX + dx;
        const dragY = nd.origY + dy;
        // Move only the dragged node in real overrides
        setPositionOverrides(prev => ({ ...prev, [nd.nodeId]: { x: dragX, y: dragY } }));
        // Compute ephemeral collision preview for neighbors
        const MARGIN = 16;
        const preview: PositionMap = {};
        const nearby = nodes.filter(n => n.id !== nd.nodeId && n.type === "session");
        const getBase = (n: GraphNode) => positionOverrides[n.id] ?? { x: n.x, y: n.y };
        const pushed = new Set<string>();
        // Pass 1: nodes overlapping the dragged node
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
        // Pass 2: pushed nodes push their own neighbors
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
      return;
    }

    if (mmDragRef.current) return; // minimap drag handled by window listeners

    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    if (!dragRef.current.hasMoved && Math.hypot(dx, dy) > 5) dragRef.current.hasMoved = true;
    const newX = dragRef.current.vpX + dx;
    const newY = dragRef.current.vpY + dy;
    const wrap = wrapRef.current;
    if (wrap) {
      const minX = -(svgW * viewport.scale - 100);
      const minY = -(svgH * viewport.scale - 100);
      const maxX = wrap.clientWidth - 100;
      const maxY = wrap.clientHeight - 100;
      setViewport(vp => ({ ...vp, x: Math.max(minX, Math.min(maxX, newX)), y: Math.max(minY, Math.min(maxY, newY)) }));
    } else {
      setViewport(vp => ({ ...vp, x: newX, y: newY }));
    }
  };
  const onPanEnd = () => {
    if (nodeDragRef.current?.hasMoved) {
      // Commit drag preview into real overrides on drop
      const previewKeys = Object.keys(dragPreview);
      if (previewKeys.length > 0) {
        setPositionOverrides(prev => {
          const next = { ...prev, ...dragPreview };
          savePositions(profileName, next);
          return next;
        });
      } else {
        savePositions(profileName, positionOverrides);
      }
      setDragPreview({});
    }
    nodeDragRef.current = null;
    // mmDragRef cleared by window listeners, not here
    dragRef.current = null;
    setDraggingChain(null);
  };

  // Touch handlers
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, vpX: viewport.x, vpY: viewport.y, hasMoved: false };
    } else if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      touchRef.current = {
        startX: (t1.clientX + t2.clientX) / 2, startY: (t1.clientY + t2.clientY) / 2,
        vpX: viewport.x, vpY: viewport.y, initialDistance: dist, initialScale: viewport.scale, hasMoved: true,
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
      const minX = -(svgW * viewport.scale - 100);
      const minY = -(svgH * viewport.scale - 100);
      const maxX = wrap.clientWidth - 100;
      const maxY = wrap.clientHeight - 100;
      setViewport(vp => ({ ...vp, x: Math.max(minX, Math.min(maxX, newX)), y: Math.max(minY, Math.min(maxY, newY)) }));
    } else if (e.touches.length === 2 && touchRef.current.initialDistance && touchRef.current.initialScale) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
      const ratio = dist / touchRef.current.initialDistance;
      const rect = wrap.getBoundingClientRect();
      const mx = (t1.clientX + t2.clientX) / 2 - rect.left;
      const my = (t1.clientY + t2.clientY) / 2 - rect.top;
      setViewport(vp => {
        const s = Math.max(0.15, Math.min(4, touchRef.current!.initialScale! * ratio));
        const r = s / vp.scale;
        return { scale: s, x: mx - r * (mx - vp.x), y: my - r * (my - vp.y) };
      });
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length === 0) touchRef.current = null;
    else if (e.touches.length === 1) {
      const touch = e.touches[0];
      touchRef.current = { startX: touch.clientX, startY: touch.clientY, vpX: viewport.x, vpY: viewport.y };
    }
  };

  // Node drag start
  const onNodeDragStart = useCallback((e: React.MouseEvent, nodeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== "session") return;
    // Only drag the single clicked node — no chain walking
    setDraggingChain(new Set([nodeId]));
    nodeDragRef.current = {
      nodeId, startX: e.clientX, startY: e.clientY,
      origX: node.x, origY: node.y, chainIds: [nodeId], hasMoved: false,
    };
  }, [nodeMap]);

  const handleSelect = useCallback((node: GraphNode) => {
    if (dragRef.current?.hasMoved || touchRef.current?.hasMoved || nodeDragRef.current?.hasMoved) return;
    setSelected(prev => prev?.id === node.id ? null : node);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleArchive = useCallback(async (id: string) => {
    await archiveSessionApi(id).catch(() => {});
    setSessions(prev => prev.filter(s => s.id !== id));
    setSelected(null);
    setContextMenu(null);
    setPositionOverrides(prev => {
      const next = { ...prev };
      delete next[id];
      savePositions(profileName, next);
      return next;
    });
  }, [profileName]);

  const handleResetView = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap || !newestSessionNode) {
      setViewport({ x: config.padX, y: config.padY, scale: 1 });
      return;
    }
    const targetX = newestSessionNode.x + NODE_W / 2;
    const targetY = newestSessionNode.y + NODE_H / 2;
    setViewport({ x: wrap.clientWidth / 2 - targetX, y: wrap.clientHeight / 2 - targetY, scale: 1 });
  }, [newestSessionNode, config.padX, config.padY]);

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

  // ── Frustum culling: only render nodes inside the visible viewport ──
  const visibleNodes = useMemo(() => {
    const wrap = wrapRef.current;
    if (!wrap) return nodes;
    const vpW = wrap.clientWidth;
    const vpH = wrap.clientHeight;
    const MARGIN = 200; // extra margin in canvas-space to avoid pop-in
    const left = -viewport.x / viewport.scale - MARGIN;
    const top = -viewport.y / viewport.scale - MARGIN;
    const right = left + vpW / viewport.scale + MARGIN * 2;
    const bottom = top + vpH / viewport.scale + MARGIN * 2;
    return nodes.filter(n => {
      const nw = n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W;
      const nh = n.type === "session" ? NODE_H : n.type === "document" ? DOC_H : COMMIT_H;
      return n.x + nw > left && n.x < right && n.y + nh > top && n.y < bottom;
    });
  }, [nodes, viewport]);

  const zoomedOut = viewport.scale < 0.4;
  const lodSimplified = viewport.scale < 0.25;

  const activeNodeId = hoveredId ?? selected?.id ?? null;
  const activeEdgeSet = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const s = new Set<string>();
    for (const e of visibleEdges) {
      if (e.from === activeNodeId || e.to === activeNodeId) s.add(`${e.from}->${e.to}`);
    }
    return s;
  }, [activeNodeId, visibleEdges]);

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

  return (
    <div className="web-panel">
      <div className="web-toolbar" onMouseDown={e => e.stopPropagation()}>
        <DateFilterPanel filter={dateFilter} onChange={setDateFilter} />
        <button
          className="web-regen-btn"
          onClick={() => { setPositionOverrides({}); savePositions(profileName, {}); }}
        >regenerate</button>
        <EdgeLayerPanel layers={edgeLayers} onChange={setEdgeLayers} />
      </div>

      <div
        className="web-canvas-wrap"
        ref={wrapRef}
        onMouseDown={onPanStart}
        onMouseMove={onPanMove}
        onMouseUp={onPanEnd}
        onMouseLeave={onPanEnd}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div
          className={`web-canvas${zoomedOut ? " web-canvas--zoomed-out" : ""}`}
          style={{ width: svgW, height: svgH, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
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

          {visibleNodes.map(node => {
            const handleTouchEndNode = (e: React.TouchEvent, doubleAction: () => void) => {
              if (touchRef.current?.hasMoved) return;
              const now = Date.now();
              if (lastTapRef.current?.id === node.id && now - lastTapRef.current.time < 300) {
                doubleAction();
                lastTapRef.current = null;
              } else {
                lastTapRef.current = { id: node.id, time: now };
              }
            };

            // ── LOD: simplified rendering at very low zoom ──
            if (lodSimplified) {
              const nw = node.type === "session" ? NODE_W : node.type === "document" ? DOC_W : COMMIT_W;
              const nh = node.type === "session" ? NODE_H : node.type === "document" ? DOC_H : COMMIT_H;
              const bg = node.type === "session"
                ? (node.session?.status === "running" ? "var(--success)" : node.session?.status === "error" ? "var(--error)" : "var(--text-muted)")
                : node.type === "commit" ? "var(--info)" : "var(--text-muted)";
              return (
                <div
                  key={node.id}
                  style={{
                    position: "absolute", left: node.x, top: node.y,
                    width: nw, height: nh,
                    background: bg, opacity: node.type === "session" ? 0.5 : 0.25,
                    borderRadius: 3, pointerEvents: "none",
                  }}
                />
              );
            }

            if (node.type === "document" && node.doc) {
              const d = node.doc;
              return (
                <div
                  key={node.id}
                  className={`web-doc-node${selected?.id === node.id ? " web-node--selected" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => handleSelect(node)}
                  onDoubleClick={() => setFileViewerPath(d.path)}
                  onTouchEnd={(e) => handleTouchEndNode(e, () => setFileViewerPath(d.path))}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={d.path}
                >
                  <span className="web-doc-icon">&#9654;</span>
                  <span className="web-doc-name">{d.filename.replace(/-handoff\.md$/, "")}</span>
                </div>
              );
            }

            if (node.type === "commit") {
              const c = node.commit!;
              return (
                <div
                  key={node.id}
                  className={`web-commit-node${selected?.id === node.id ? " web-node--selected" : ""}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => handleSelect(node)}
                  onMouseEnter={() => setHoveredId(node.id)}
                  onMouseLeave={() => setHoveredId(null)}
                  title={c.message}
                >
                  <span className="web-commit-hash">{shortHash(c.hash)}</span>
                  <span className="web-commit-msg">{c.message.split("\n")[0].slice(0, 34)}</span>
                </div>
              );
            }

            const s = node.session!;
            const statusClass = s.status === "running" ? "running" : s.status === "error" ? "error" : "done";
            return (
              <div
                key={node.id}
                className={`web-session-node web-session-node--${statusClass}${selected?.id === node.id ? " web-node--selected" : ""}${draggingChain?.has(node.id) ? " web-session-node--dragging" : ""}`}
                style={{ left: node.x, top: node.y }}
                onClick={() => handleSelect(node)}
                onDoubleClick={() => setMiniSessionId(s.id)}
                onTouchEnd={(e) => handleTouchEndNode(e, () => setMiniSessionId(s.id))}
                onMouseDown={(e) => onNodeDragStart(e, node.id)}
                onContextMenu={(e) => handleContextMenu(e, s.id)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="web-session-top">
                  <span className={`web-session-dot web-session-dot--${statusClass}`} />
                  <span className="web-session-id">{shortId(s.id)}</span>
                  <span className="web-session-time">{timeAgo(s.created_at)}</span>
                </div>
                <div className="web-session-title">
                  {(s.title || s.preview || "").slice(0, 48)}
                </div>
                <div className="web-session-meta">
                  {s.profile && <span className="web-session-profile">{s.profile}</span>}
                  {node.handoffType && <span className="web-session-handoff-type">{node.handoffType}</span>}
                  <span>{s.message_count} msgs</span>
                  <span>{formatCost(s.total_cost_usd)}</span>
                  {(() => {
                    const tc = sessionTouchCounts.get(s.id);
                    if (!tc) return null;
                    return (
                      <>
                        {tc.reads > 0 && <span className="web-session-reads">{tc.reads}r</span>}
                        {tc.edits > 0 && <span className="web-session-edits">{tc.edits}w</span>}
                      </>
                    );
                  })()}
                </div>
              </div>
            );
          })}
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
        {/* Minimap — bottom timeline strip */}
        {nodes.length > 0 && (() => {
          const mmH = 80;
          const mmW = wrapRef.current?.clientWidth ?? 800;
          const scaleX = mmW / svgW;
          const scaleY = mmH / svgH;
          const vpW = wrapRef.current?.clientWidth ?? 800;
          const vpH = wrapRef.current?.clientHeight ?? 600;
          const vrX = Math.max(0, (-viewport.x / viewport.scale) * scaleX);
          const vrY = Math.max(0, (-viewport.y / viewport.scale) * scaleY);
          const vrW = Math.min(mmW - vrX, (vpW / viewport.scale) * scaleX);
          const vrH = Math.min(mmH - vrY, (vpH / viewport.scale) * scaleY);
          return (
            <div
              className="web-minimap"
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

                // Immediately jump viewport to center on click position
                const mx = (e.clientX - rect.left) / curScaleX;
                const my = (e.clientY - rect.top) / curScaleY;
                const jumpVpX = -(mx - curVpW / (2 * viewport.scale)) * viewport.scale;
                const jumpVpY = -(my - curVpH / (2 * viewport.scale)) * viewport.scale;
                setViewport(vp => ({ ...vp, x: jumpVpX, y: jumpVpY }));

                // Use jumped position as drag baseline
                mmDragRef.current = { startX, startY, startVpX: jumpVpX, startVpY: jumpVpY, hasMoved: false };

                const onMove = (ev: MouseEvent) => {
                  const dx = ev.clientX - startX;
                  const dy = ev.clientY - startY;
                  if (Math.hypot(dx, dy) > 3) mmDragRef.current!.hasMoved = true;
                  const wrap = wrapRef.current;
                  if (wrap) {
                    const minX = -(svgW * viewport.scale - 100);
                    const maxX = wrap.clientWidth - 100;
                    const minY = -(svgH * viewport.scale - 100);
                    const maxY = wrap.clientHeight - 100;
                    setViewport(vp => ({
                      ...vp,
                      x: Math.max(minX, Math.min(maxX, jumpVpX - (dx / curScaleX) * vp.scale)),
                      y: Math.max(minY, Math.min(maxY, jumpVpY - (dy / curScaleY) * vp.scale)),
                    }));
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
                const mx = (touch.clientX - rect.left) / curScaleX;
                const my = (touch.clientY - rect.top) / curScaleY;
                const jumpVpX = -(mx - curVpW / (2 * viewport.scale)) * viewport.scale;
                const jumpVpY = -(my - curVpH / (2 * viewport.scale)) * viewport.scale;
                setViewport(vp => ({ ...vp, x: jumpVpX, y: jumpVpY }));
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
                  const minX = -(svgW * viewport.scale - 100);
                  const maxX = wrap.clientWidth - 100;
                  const minY = -(svgH * viewport.scale - 100);
                  const maxY = wrap.clientHeight - 100;
                  setViewport(vp => ({
                    ...vp,
                    x: Math.max(minX, Math.min(maxX, mmDragRef.current!.startVpX - (dx / curScaleX) * vp.scale)),
                    y: Math.max(minY, Math.min(maxY, mmDragRef.current!.startVpY - (dy / curScaleY) * vp.scale)),
                  }));
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
                    // separator line at left edge
                    if (idx > 0) {
                      elements.push(
                        <line key={`mm-sep-${cl.id}`} x1={px} y1={0} x2={px} y2={mmH}
                          stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
                      );
                    }
                    elements.push(
                      <rect
                        key={`mm-band-${cl.id}`}
                        x={px} y={0}
                        width={bw * scaleX} height={mmH}
                        fill={idx % 2 === 0 ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.035)"}
                      />
                    );
                    idx++;
                  }
                  return elements;
                })()}
                {nodes.map(n => {
                  const w = n.type === "session" ? NODE_W : n.type === "document" ? DOC_W : COMMIT_W;
                  const h = n.type === "session" ? NODE_H : n.type === "document" ? DOC_H : COMMIT_H;
                  const cls = n.type === "session"
                    ? (n.session?.status === "running" ? "web-mm-running" : "web-mm-session")
                    : n.type === "commit" ? "web-mm-commit" : "web-mm-doc";
                  return (
                    <rect
                      key={n.id}
                      x={n.x * scaleX} y={n.y * scaleY}
                      width={Math.max(w * scaleX, 2)} height={Math.max(h * scaleY, 1.5)}
                      className={cls}
                    />
                  );
                })}
                <rect
                  x={vrX} y={vrY} width={vrW} height={vrH}
                  className="web-mm-viewport"
                />
              </svg>
            </div>
          );
        })()}
        <MissionFilterPanel runs={missionRuns} activeRunId={missionFilter} onChange={setMissionFilter} />
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x} y={contextMenu.y}
          onArchive={() => handleArchive(contextMenu.sessionId)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {selected && <DetailPanel node={selected} onClose={() => setSelected(null)} onArchive={handleArchive} />}

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
