import { useState, useEffect, useMemo, useCallback } from "react";
import { fetchSessions } from "../api/sessions";
import { fetchGitLog } from "../api/git";
import { API_BASE, authHeaders } from "../api/_fetch";
import type { SessionInfo, GitCommit } from "../api/types";

// ── Types ──

type MoveRun = {
  id: number;
  moveName: string;
  sessionId: string;
  mode: string;
  status: string;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
  spawnedSessionId: string | null;
};

type GraphNode = {
  id: string;
  type: "session" | "commit";
  x: number;
  y: number;
  col: number;
  row: number;
  session?: SessionInfo;
  commit?: GitCommit;
  tags?: string[];
  handoffType?: string;
};

type GraphEdge = {
  from: string;
  to: string;
  type: "handoff" | "commit";
  moveName?: string;
};

type SelectedNode = GraphNode | null;

// ── Helpers ──

function parseTags(tags: string): string[] {
  try { return JSON.parse(tags); }
  catch { return []; }
}

function shortId(id: string) { return id.slice(0, 8); }
function shortHash(h: string) { return h.slice(0, 7); }

function timeAgo(epoch: number): string {
  const diff = Date.now() - epoch;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ── Layout Constants ──

const COL_WIDTH = 200;
const ROW_HEIGHT = 80;
const NODE_W = 150;
const NODE_H = 52;
const COMMIT_R = 14;
const PAD_X = 40;
const PAD_Y = 40;
const COMMIT_OFFSET_Y = 60;

// ── Graph Builder ──

function buildGraph(
  sessions: SessionInfo[],
  moveRuns: MoveRun[],
  commits: GitCommit[],
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const edges: GraphEdge[] = [];
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  // Handoff edges: source → spawned
  const handoffEdges = moveRuns
    .filter(r => r.spawnedSessionId && sessionMap.has(r.sessionId) && sessionMap.has(r.spawnedSessionId!))
    .map(r => ({
      from: r.sessionId,
      to: r.spawnedSessionId!,
      type: "handoff" as const,
      moveName: r.moveName,
    }));
  edges.push(...handoffEdges);

  // Build commit tag map: hash → session IDs
  const commitSessionMap = new Map<string, string[]>();
  for (const s of sessions) {
    const tags = parseTags(s.tags);
    for (const t of tags) {
      if (t.startsWith("commit:")) {
        const hash = t.slice(7);
        const arr = commitSessionMap.get(hash) || [];
        arr.push(s.id);
        commitSessionMap.set(hash, arr);
      }
    }
  }

  // Only include commits that are linked to sessions
  const linkedCommits = commits.filter(c =>
    commitSessionMap.has(shortHash(c.hash)) || commitSessionMap.has(c.hash)
  );

  // Commit edges
  for (const c of linkedCommits) {
    const h7 = shortHash(c.hash);
    const linked = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    for (const sid of linked) {
      edges.push({ from: sid, to: `commit:${h7}`, type: "commit" });
    }
  }

  // Compute session depth via BFS
  const spawnedSet = new Set(handoffEdges.map(e => e.to));
  const childrenOf = new Map<string, string[]>();
  for (const e of handoffEdges) {
    const arr = childrenOf.get(e.from) || [];
    arr.push(e.to);
    childrenOf.set(e.from, arr);
  }

  // Sessions that participate in handoffs
  const handoffSessionIds = new Set<string>();
  for (const e of handoffEdges) {
    handoffSessionIds.add(e.from);
    handoffSessionIds.add(e.to);
  }
  // Also include sessions with commit links
  for (const [, sids] of commitSessionMap) {
    for (const sid of sids) handoffSessionIds.add(sid);
  }

  // If no relationships at all, show recent sessions as a simple grid
  const relevantSessionIds = handoffSessionIds.size > 0
    ? handoffSessionIds
    : new Set(sessions.slice(0, 12).map(s => s.id));

  const depth = new Map<string, number>();
  const roots: string[] = [];
  for (const sid of relevantSessionIds) {
    if (!spawnedSet.has(sid)) {
      roots.push(sid);
      depth.set(sid, 0);
    }
  }
  // BFS
  const queue = [...roots];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = depth.get(cur) ?? 0;
    for (const child of childrenOf.get(cur) || []) {
      if (!depth.has(child)) {
        depth.set(child, d + 1);
        queue.push(child);
      }
    }
  }
  // Orphans (in relevantSessionIds but not reachable) get depth 0
  for (const sid of relevantSessionIds) {
    if (!depth.has(sid)) depth.set(sid, 0);
  }

  // Group by column, sort by time within column
  const columns = new Map<number, string[]>();
  for (const sid of relevantSessionIds) {
    const col = depth.get(sid) ?? 0;
    const arr = columns.get(col) || [];
    arr.push(sid);
    columns.set(col, arr);
  }
  for (const [, sids] of columns) {
    sids.sort((a, b) => {
      const sa = sessionMap.get(a);
      const sb = sessionMap.get(b);
      return (sa?.created_at ?? 0) - (sb?.created_at ?? 0);
    });
  }

  // Position session nodes
  const nodes: GraphNode[] = [];
  for (const [col, sids] of columns) {
    for (let row = 0; row < sids.length; row++) {
      const s = sessionMap.get(sids[row])!;
      const tags = parseTags(s.tags);
      const handoffType = tags.find(t => t.startsWith("handoff:"))?.slice(8);
      nodes.push({
        id: s.id,
        type: "session",
        x: PAD_X + col * COL_WIDTH,
        y: PAD_Y + row * ROW_HEIGHT,
        col,
        row,
        session: s,
        tags,
        handoffType,
      });
    }
  }

  // Position commit nodes — below the first linked session
  const sessionNodeMap = new Map(nodes.map(n => [n.id, n]));
  const commitOffsetCount = new Map<string, number>();
  for (const c of linkedCommits) {
    const h7 = shortHash(c.hash);
    const linked = commitSessionMap.get(h7) || commitSessionMap.get(c.hash) || [];
    if (linked.length === 0) continue;
    const firstSession = sessionNodeMap.get(linked[0]);
    if (!firstSession) continue;
    const count = commitOffsetCount.get(linked[0]) || 0;
    commitOffsetCount.set(linked[0], count + 1);
    nodes.push({
      id: `commit:${h7}`,
      type: "commit",
      x: firstSession.x + 20 + count * 44,
      y: firstSession.y + COMMIT_OFFSET_Y,
      col: firstSession.col,
      row: firstSession.row,
      commit: c,
    });
  }

  return { nodes, edges };
}

// ── SVG Edge ──

function EdgePath({ from, to, type }: {
  from: GraphNode;
  to: GraphNode;
  type: "handoff" | "commit";
}) {
  const x1 = from.type === "session" ? from.x + NODE_W : from.x + COMMIT_R;
  const y1 = from.type === "session" ? from.y + NODE_H / 2 : from.y + COMMIT_R;
  const x2 = to.type === "session" ? to.x : to.x + COMMIT_R;
  const y2 = to.type === "session" ? to.y + NODE_H / 2 : to.y;

  if (type === "commit") {
    // Straight line down to commit
    const cx = from.x + NODE_W / 2;
    const cy1 = from.y + NODE_H;
    return (
      <line
        x1={cx} y1={cy1}
        x2={to.x + COMMIT_R} y2={to.y}
        className="web-edge web-edge--commit"
      />
    );
  }

  // Handoff: cubic bezier curving right
  const dx = Math.abs(x2 - x1);
  const cp = Math.max(dx * 0.4, 40);
  const d = `M ${x1} ${y1} C ${x1 + cp} ${y1}, ${x2 - cp} ${y2}, ${x2} ${y2}`;
  return <path d={d} className="web-edge web-edge--handoff" />;
}

// ── Detail Panel ──

function DetailPanel({ node, onClose }: { node: GraphNode; onClose: () => void }) {
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
    </div>
  );
}

// ── Main Component ──

export function SessionWeb() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [moveRuns, setMoveRuns] = useState<MoveRun[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<SelectedNode>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Fetch all data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [sessData, moveData, gitData] = await Promise.all([
          fetchSessions(100),
          fetch(`${API_BASE}/api/move-runs/recent?limit=100`, { headers: authHeaders() }).then(r => r.json()),
          fetchGitLog(".", 50).catch(() => [] as GitCommit[]),
        ]);
        if (!cancelled) {
          setSessions(sessData);
          setMoveRuns(moveData);
          setCommits(gitData);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const { nodes, edges } = useMemo(
    () => buildGraph(sessions, moveRuns, commits),
    [sessions, moveRuns, commits],
  );

  const nodeMap = useMemo(
    () => new Map(nodes.map(n => [n.id, n])),
    [nodes],
  );

  // Compute SVG viewport
  const svgW = useMemo(() => {
    const maxX = Math.max(...nodes.map(n => n.x + (n.type === "session" ? NODE_W : COMMIT_R * 2)), 400);
    return maxX + PAD_X;
  }, [nodes]);

  const svgH = useMemo(() => {
    const maxY = Math.max(...nodes.map(n => n.y + (n.type === "session" ? NODE_H : COMMIT_R * 2) + COMMIT_OFFSET_Y), 300);
    return maxY + PAD_Y;
  }, [nodes]);

  const handleSelect = useCallback((node: GraphNode) => {
    setSelected(prev => prev?.id === node.id ? null : node);
  }, []);

  // Edges connected to hovered/selected node
  const activeNodeId = hoveredId ?? selected?.id ?? null;
  const activeEdgeSet = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const s = new Set<string>();
    for (const e of edges) {
      if (e.from === activeNodeId || e.to === activeNodeId) {
        s.add(`${e.from}->${e.to}`);
      }
    }
    return s;
  }, [activeNodeId, edges]);

  if (loading) {
    return (
      <div className="web-panel">
        <div className="web-empty">loading...</div>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="web-panel">
        <div className="web-empty">no session links yet — handoff sessions to build the web</div>
      </div>
    );
  }

  return (
    <div className="web-panel">
      <div className="web-canvas-wrap">
        <div className="web-canvas" style={{ width: svgW, height: svgH }}>
          {/* SVG edge layer */}
          <svg className="web-svg" width={svgW} height={svgH}>
            {edges.map((e, i) => {
              const from = nodeMap.get(e.from);
              const to = nodeMap.get(e.to);
              if (!from || !to) return null;
              const edgeKey = `${e.from}->${e.to}`;
              const active = activeEdgeSet.has(edgeKey);
              return (
                <g key={i} className={active ? "web-edge-active" : ""}>
                  <EdgePath from={from} to={to} type={e.type} />
                </g>
              );
            })}
          </svg>

          {/* Node layer */}
          {nodes.map(node => {
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
                  title={`${shortHash(c.hash)} — ${c.message}`}
                >
                  <span className="web-commit-hash">{shortHash(c.hash)}</span>
                </div>
              );
            }

            const s = node.session!;
            const statusClass = s.status === "running" ? "running" : s.status === "error" ? "error" : "done";
            return (
              <div
                key={node.id}
                className={`web-session-node web-session-node--${statusClass}${selected?.id === node.id ? " web-node--selected" : ""}`}
                style={{ left: node.x, top: node.y }}
                onClick={() => handleSelect(node)}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="web-session-top">
                  <span className={`web-session-dot web-session-dot--${statusClass}`} />
                  <span className="web-session-id">{shortId(s.id)}</span>
                  <span className="web-session-time">{timeAgo(s.created_at)}</span>
                </div>
                <div className="web-session-bottom">
                  {s.profile && <span className="web-session-profile">{s.profile}</span>}
                  {node.handoffType && <span className="web-session-handoff-type">{node.handoffType}</span>}
                  {!s.profile && !node.handoffType && (
                    <span className="web-session-preview">{(s.title || s.preview || "").slice(0, 24)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Detail panel */}
      {selected && <DetailPanel node={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
