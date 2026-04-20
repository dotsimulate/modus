/**
 * Mission graph widget — DAG view of a mission run.
 *
 * Renders spawned sessions as nodes with transfer edges between them.
 * Edges are directional (arrowheads) and typed:
 *   delegation (orchestrator → worker)
 *   report     (worker → orchestrator)
 *   review     (reviewer → orchestrator)
 *   escalation (worker → orchestrator)
 *
 * Layout: simple layered sugiyama-style pass — depth by delegation distance
 * from the root (orchestrator), vertical stacking within a layer by createdAt.
 *
 * pageContext:
 *   subscribe ← missionRunId
 *   emits     → select-session
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { modus } from "../modusClient";
import type {
  MissionTransferSummary,
  MissionRunSummary,
  SessionInfo,
  ActiveSessionInfo,
} from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { useWidgetPollingValue } from "./widget-data";
import { WidgetEmptyState } from "./widget-components";

type MissionGraphConfig = WidgetBase & {
  type: "mission-graph";
};

type Node = {
  id: string;
  label: string;
  profile: string | null;
  status: string;
  role: string | null;
  isOrchestrator: boolean;
  depth: number;
  order: number;
  x: number;
  y: number;
};

type Edge = {
  id: number;
  from: string;
  to: string;
  kind: MissionTransferSummary["kind"];
  stepId: string;
  summary: string | null;
  createdAt: number;
  lane: number;
};

// ── Layout constants ──

const NODE_W = 180;
const NODE_H = 64;
const LAYER_GAP_X = 110;
const NODE_GAP_Y = 26;
const PAD = 40;

// ── Derive roles & depths ──

function buildGraph(
  sessionIds: string[],
  transfers: MissionTransferSummary[],
  sessionInfos: Map<string, SessionInfo>,
  activeInfos: Map<string, ActiveSessionInfo>,
  run: MissionRunSummary | null,
): { nodes: Node[]; edges: Edge[]; width: number; height: number } {
  if (sessionIds.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  // Find orchestrator: the session that is `from` of the earliest delegation,
  // or the first session if no delegation exists.
  const delegations = transfers
    .filter(t => t.kind === "delegation" && t.fromSessionId && t.toSessionId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const orchestratorId = delegations[0]?.fromSessionId ?? sessionIds[0];

  // Depth via BFS from orchestrator along delegation edges.
  const depth = new Map<string, number>();
  depth.set(orchestratorId, 0);
  const queue: string[] = [orchestratorId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const curD = depth.get(cur)!;
    for (const t of delegations) {
      if (t.fromSessionId !== cur || !t.toSessionId) continue;
      if (depth.has(t.toSessionId)) continue;
      depth.set(t.toSessionId, curD + 1);
      queue.push(t.toSessionId);
    }
  }
  for (const id of sessionIds) {
    if (!depth.has(id)) depth.set(id, 1); // unplaced → put in worker column
  }

  // Determine roles: scan delegations for the role field injected via stepId
  // (we only have stepId on transfers, not role — use orchestrator flag).
  const firstSeen = new Map<string, number>();
  for (const t of transfers) {
    if (t.fromSessionId && !firstSeen.has(t.fromSessionId)) firstSeen.set(t.fromSessionId, t.createdAt);
    if (t.toSessionId && !firstSeen.has(t.toSessionId)) firstSeen.set(t.toSessionId, t.createdAt);
  }

  // Group by depth (column), sort by firstSeen (row).
  const byDepth = new Map<number, string[]>();
  for (const id of sessionIds) {
    const d = depth.get(id)!;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(id);
  }
  for (const list of byDepth.values()) {
    list.sort((a, b) => (firstSeen.get(a) ?? 0) - (firstSeen.get(b) ?? 0));
  }

  const maxDepth = Math.max(...Array.from(byDepth.keys()));
  const maxCol = Math.max(...Array.from(byDepth.values()).map(a => a.length));
  const width = PAD * 2 + (maxDepth + 1) * NODE_W + maxDepth * LAYER_GAP_X;
  const height = PAD * 2 + maxCol * NODE_H + (maxCol - 1) * NODE_GAP_Y;

  const nodes: Node[] = [];
  for (const [d, ids] of byDepth) {
    const colCount = ids.length;
    const colHeight = colCount * NODE_H + (colCount - 1) * NODE_GAP_Y;
    const startY = (height - colHeight) / 2;
    ids.forEach((id, i) => {
      const info = sessionInfos.get(id);
      const active = activeInfos.get(id);
      const status = active?.status ?? info?.status ?? "unknown";
      const profile = info?.profile ?? active?.profile ?? null;
      const preview = info?.title || info?.last_prompt || info?.preview || active?.preview || id.slice(0, 8);
      nodes.push({
        id,
        label: preview,
        profile,
        status,
        role: null,
        isOrchestrator: id === orchestratorId,
        depth: d,
        order: i,
        x: PAD + d * (NODE_W + LAYER_GAP_X),
        y: startY + i * (NODE_H + NODE_GAP_Y),
      });
    });
  }

  // Build edges with lane offset per (from, to) ordered pair.
  const idSet = new Set(sessionIds);
  const grouped = new Map<string, MissionTransferSummary[]>();
  for (const t of transfers) {
    if (!t.fromSessionId || !t.toSessionId) continue;
    if (!idSet.has(t.fromSessionId) || !idSet.has(t.toSessionId)) continue;
    const key = `${t.fromSessionId}→${t.toSessionId}`;
    const list = grouped.get(key) ?? [];
    list.push(t);
    grouped.set(key, list);
  }

  const edges: Edge[] = [];
  for (const [, list] of grouped) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    list.forEach((t, i) => {
      edges.push({
        id: t.id,
        from: t.fromSessionId!,
        to: t.toSessionId!,
        kind: t.kind,
        stepId: t.stepId,
        summary: t.summary,
        createdAt: t.createdAt,
        lane: i,
      });
    });
  }

  // Mark run status unused to keep signature stable
  void run;

  return { nodes, edges, width, height };
}

// ── Anchor / edge path helpers ──

function anchor(n: Node, toX: number, toY: number): { x: number; y: number } {
  const cx = n.x + NODE_W / 2;
  const cy = n.y + NODE_H / 2;
  const dx = toX - cx;
  const dy = toY - cy;
  const halfW = NODE_W / 2;
  const halfH = NODE_H / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const s = Math.min(scaleX, scaleY, 1);
  return { x: cx + dx * s, y: cy + dy * s };
}

function edgePath(from: Node, to: Node, lane: number): string {
  const sx = from.x + NODE_W / 2;
  const sy = from.y + NODE_H / 2;
  const tx = to.x + NODE_W / 2;
  const ty = to.y + NODE_H / 2;
  const p1 = anchor(from, tx, ty);
  const p2 = anchor(to, sx, sy);

  // Curve: orthogonal-ish with a bezier, lane offset nudges mid
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dist = Math.hypot(dx, dy);
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;
  const laneOffset = lane * 16;
  const mx = (p1.x + p2.x) / 2 + nx * (24 + laneOffset);
  const my = (p1.y + p2.y) / 2 + ny * (24 + laneOffset);

  return `M ${p1.x} ${p1.y} Q ${mx} ${my} ${p2.x} ${p2.y}`;
}

function statusDotClass(status: string): string {
  if (status === "running") return "streaming";
  if (status === "pending" || status === "starting") return "running";
  if (status === "error" || status === "failed") return "error";
  if (status === "done" || status === "completed" || status === "idle") return "done";
  return "idle";
}

// ── Main ──

export default function MissionGraphWidget({ pageContext, onSelectSession }: WidgetProps<MissionGraphConfig>) {
  const runIdRaw = pageContext?.get("missionRunId");
  const runId = typeof runIdRaw === "number" ? runIdRaw : null;

  const [run, setRun] = useState<MissionRunSummary | null>(null);
  useEffect(() => {
    if (!runId) { setRun(null); return; }
    let cancelled = false;
    modus.getMissionRun(runId).then(r => { if (!cancelled) setRun(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [runId]);

  const loadSessionIds = useCallback(
    () => (runId ? modus.getMissionSessions(runId) : Promise.resolve([])),
    [runId],
  );
  const loadTransfers = useCallback(
    () => (runId ? modus.getMissionTransfers(runId) : Promise.resolve([])),
    [runId],
  );

  const { value: sessionIds } = useWidgetPollingValue<string[]>({
    load: loadSessionIds, scopeKey: `mgraph-sessions:${runId}`, intervalMs: 5000, initialValue: [],
  });
  const { value: transfers } = useWidgetPollingValue<MissionTransferSummary[]>({
    load: loadTransfers, scopeKey: `mgraph-transfers:${runId}`, intervalMs: 3000, initialValue: [],
  });

  const loadSessions = useCallback(async () => {
    if (sessionIds.length === 0) return [];
    const all = await modus.listSessions({ limit: 500 });
    const s = new Set(sessionIds);
    return all.filter(x => s.has(x.id));
  }, [sessionIds]);
  const loadActive = useCallback(() => modus.getActiveSessions(), []);

  const { value: sessions } = useWidgetPollingValue<SessionInfo[]>({
    load: loadSessions,
    scopeKey: `mgraph-session-infos:${runId}:${sessionIds.length}`,
    intervalMs: 5000, initialValue: [],
  });
  const { value: active } = useWidgetPollingValue<ActiveSessionInfo[]>({
    load: loadActive, scopeKey: "mgraph-active", intervalMs: 3000, initialValue: [],
  });

  const graph = useMemo(() => {
    const infoMap = new Map(sessions.map(s => [s.id, s]));
    const activeMap = new Map(active.map(a => [a.id, a]));
    return buildGraph(sessionIds, transfers, infoMap, activeMap, run);
  }, [sessionIds, transfers, sessions, active, run]);

  // Selected session from page bus so the graph can highlight it.
  const selectedSessionRaw = pageContext?.get("sessionId") ?? pageContext?.get("selectedSession");
  const selectedSession = typeof selectedSessionRaw === "string" ? selectedSessionRaw : null;

  const handleSelect = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  // ── Pan / zoom ──
  const [viewport, setViewport] = useState({ x: 0, y: 0, scale: 1 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = { x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  }, [viewport.x, viewport.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setViewport(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  // Attach wheel as a non-passive native listener so preventDefault works.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY * 0.001;
      setViewport(v => {
        const next = Math.max(0.3, Math.min(2.5, v.scale * (1 + delta)));
        return { ...v, scale: next };
      });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const fitView = useCallback(() => {
    if (!svgRef.current || graph.width === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const sx = (rect.width - 40) / graph.width;
    const sy = (rect.height - 40) / graph.height;
    const scale = Math.min(1, sx, sy);
    setViewport({
      x: (rect.width - graph.width * scale) / 2,
      y: (rect.height - graph.height * scale) / 2,
      scale,
    });
  }, [graph.width, graph.height]);

  // Auto-fit on new graph size
  const prevSize = useRef({ w: 0, h: 0 });
  useEffect(() => {
    if (graph.width !== prevSize.current.w || graph.height !== prevSize.current.h) {
      prevSize.current = { w: graph.width, h: graph.height };
      fitView();
    }
  }, [graph.width, graph.height, fitView]);

  if (!runId) return <WidgetEmptyState>select a mission run to see its graph</WidgetEmptyState>;
  if (graph.nodes.length === 0) {
    return <WidgetEmptyState>no spawned sessions yet</WidgetEmptyState>;
  }

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));

  return (
    <div className="mission-graph-widget">
      <div className="mission-graph-toolbar">
        <span className="mission-graph-label">
          {run ? `${run.missionName} · run #${run.id}` : `run #${runId}`}
        </span>
        <button className="mission-graph-btn" onClick={fitView} title="Fit to view">fit</button>
        <div className="mission-graph-legend">
          <span className="mgl mgl--delegation">delegation</span>
          <span className="mgl mgl--report">report</span>
          <span className="mgl mgl--review">review</span>
          <span className="mgl mgl--escalation">escalation</span>
        </div>
      </div>
      <svg
        ref={svgRef}
        className="mission-graph-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <defs>
          {(["delegation", "report", "review", "escalation"] as const).map(kind => (
            <marker
              key={kind}
              id={`mgraph-arrow-${kind}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
              markerUnits="userSpaceOnUse"
            >
              <path d="M 0 0 L 10 5 L 0 10 Z" className={`mgraph-arrow mgraph-arrow--${kind}`} />
            </marker>
          ))}
        </defs>

        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}>
          {/* Edges first so nodes render on top */}
          {graph.edges.map(e => {
            const from = nodeMap.get(e.from);
            const to = nodeMap.get(e.to);
            if (!from || !to) return null;
            return (
              <path
                key={e.id}
                d={edgePath(from, to, e.lane)}
                className={`mgraph-edge mgraph-edge--${e.kind}`}
                markerEnd={`url(#mgraph-arrow-${e.kind})`}
                fill="none"
              >
                <title>{`${e.kind} · ${e.stepId}${e.summary ? ` · ${e.summary}` : ""}`}</title>
              </path>
            );
          })}

          {/* Nodes */}
          {graph.nodes.map(n => {
            const isSel = n.id === selectedSession;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                className={`mgraph-node${isSel ? " selected" : ""}${n.isOrchestrator ? " orchestrator" : ""}`}
                onClick={e => { e.stopPropagation(); handleSelect(n.id); }}
                style={{ cursor: "pointer" }}
              >
                <rect width={NODE_W} height={NODE_H} rx={6} className="mgraph-node-bg" />
                <circle cx={10} cy={12} r={4} className={`mgraph-node-dot mgraph-node-dot--${statusDotClass(n.status)}`} />
                <text x={22} y={16} className="mgraph-node-title">
                  {n.isOrchestrator ? "◆ " : ""}{n.label.slice(0, 22)}
                </text>
                {n.profile && (
                  <text x={12} y={36} className="mgraph-node-profile">{n.profile}</text>
                )}
                <text x={12} y={54} className="mgraph-node-id">{n.id.slice(0, 8)}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
