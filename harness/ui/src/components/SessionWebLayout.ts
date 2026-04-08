/**
 * SessionWebLayout — types, constants, persistence, and display helpers.
 * No layout logic. No React. Pure foundation.
 */

import type { SessionInfo, GitCommit, MissionTransferSummary } from "../../../sdk/index";

// ── Types ──

export type MoveRun = {
  id: number;
  moveName: string;
  sessionId: string;
  mode: string;
  status: string;
  summary: string | null;
  createdAt: number;
  completedAt: number | null;
  spawnedSessionId: string | null;
  gatheredContext?: string;
};

export type HandoffDoc = {
  path: string;
  filename: string;
  moveRunId: number;
  fromSessionId: string;
  toSessionId: string;
};

export type GraphNode = {
  id: string;
  type: "session" | "commit" | "document";
  x: number;
  y: number;
  col: number;
  row: number;
  color?: string | null;
  session?: SessionInfo;
  commit?: GitCommit;
  doc?: HandoffDoc;
  tags?: string[];
  handoffType?: string;
  dayKey?: string;
};

export type EdgeType = "handoff" | "commit" | "document" | "delegation" | "co-edit" | "co-read";

export type GraphEdge = {
  from: string;
  to: string;
  type: EdgeType;
  moveName?: string;
  lane?: number;
  kind?: MissionTransferSummary["kind"];
  sharedFiles?: number;
};

export type EdgeLayers = {
  handoff: boolean;
  delegation: boolean;
  commit: boolean;
  "co-edit": boolean;
  "co-read": boolean;
};

export type WebLayoutConfig = {
  axisMode: "time-x" | "time-y";
  timeDirection: "ltr" | "rtl";
  rowWidth: number;
  colHeight: number;
  padX: number;
  padY: number;
  commitOffsetX: number;
  siblingGapRows: number;
  rootGapRows: number;
};

export type PositionMap = Record<string, { x: number; y: number }>;
export type DateFilter = { startDate: string | null; endDate: string | null };

export type TimeCluster = {
  id: string;
  label: string;
  x: number;
  width: number;
  sessionCount: number;
  commitCount: number;
};

// ── Constants ──

export const NODE_W = 260;
export const NODE_H = 84;
export const DOC_W = 180;
export const DOC_H = 32;
export const COMMIT_W = 200;
export const COMMIT_H = 30;
export const COMMIT_GAP_Y = 6;
export const WINDOW_PAD = 24;
export const WINDOW_HEADER_H = 22;
export const CLUSTER_GAP = 16;
export const PAD_NODE_W = NODE_W + 28;

// Base padding for collision detection (8px more per side)
export const BASE_PAD_NODE_W = PAD_NODE_W - 4;

// Default jitter ranges for placement
// Handoff: tighter, co-edit/co-read: more constrained
// No-conn: slightly looser for roots
export const PAD_NODE_H = NODE_H + 28;

export const DEFAULT_CONFIG: WebLayoutConfig = {
  axisMode: "time-x",
  timeDirection: "ltr",
  rowWidth: 340,
  colHeight: 140,
  padX: 60,
  padY: 60,
  commitOffsetX: 10,
  siblingGapRows: 0.3,
  rootGapRows: 0.6,
};

export const PRESETS: Record<string, WebLayoutConfig> = {
  default: { ...DEFAULT_CONFIG },
  compact: { ...DEFAULT_CONFIG, rowWidth: 280, colHeight: 100, padX: 30, padY: 30, commitOffsetX: 6, siblingGapRows: 0.15, rootGapRows: 0.3 },
  wide: { ...DEFAULT_CONFIG, rowWidth: 480, colHeight: 200, padX: 80, padY: 80, siblingGapRows: 0.5, rootGapRows: 1 },
};

export const DEFAULT_LAYERS: EdgeLayers = {
  handoff: true,
  delegation: true,
  commit: true,
  "co-edit": false,
  "co-read": false,
};

// ── Storage keys ──

export const STORAGE_KEY = "mo:web-layout";
export const FILTER_KEY_PREFIX = "mo:web-filter:";
export const POSITIONS_KEY_PREFIX = "mo:web-positions:";
export const LAYERS_KEY_PREFIX = "mo:web-layers:";

// ── Persistence helpers ──

export function loadConfig(): WebLayoutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg: WebLayoutConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function loadDateFilter(profileName: string): DateFilter {
  try {
    const raw = localStorage.getItem(FILTER_KEY_PREFIX + profileName);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { startDate: null, endDate: null };
}

export function saveDateFilter(profileName: string, filter: DateFilter) {
  localStorage.setItem(FILTER_KEY_PREFIX + profileName, JSON.stringify(filter));
}

export function loadPositions(profileName: string): PositionMap {
  try {
    const raw = localStorage.getItem(POSITIONS_KEY_PREFIX + profileName);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

export function savePositions(profileName: string, positions: PositionMap) {
  localStorage.setItem(POSITIONS_KEY_PREFIX + profileName, JSON.stringify(positions));
}

export function loadLayers(profileName: string): EdgeLayers {
  try {
    const raw = localStorage.getItem(LAYERS_KEY_PREFIX + profileName);
    if (raw) return { ...DEFAULT_LAYERS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYERS };
}

export function saveLayers(profileName: string, layers: EdgeLayers) {
  localStorage.setItem(LAYERS_KEY_PREFIX + profileName, JSON.stringify(layers));
}

// ── Display helpers ──

export function stableJitter(id: string, range: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  return ((h & 0xffff) / 0xffff - 0.5) * range;
}

export function shortId(id: string) { return id.slice(0, 8); }
export function shortHash(hash: string) { return hash.slice(0, 7); }
export function commitTimestamp(c: GitCommit) { return new Date(c.date).getTime(); }

export function parseTags(raw: string): string[] {
  try { return JSON.parse(raw); } catch { return []; }
}

export function formatCost(usd: number) {
  if (usd < 0.01) return `$${(usd * 100).toFixed(1)}¢`;
  return `$${usd.toFixed(2)}`;
}

export function timeAgo(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatDayLabel(key: string): string {
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);
  if (key === today) return "today";
  if (key === yesterday) return "yesterday";
  const [, m, d] = key.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ── Node geometry helpers ──

export function nodeBottom(n: GraphNode) {
  if (n.type === "session") return n.y + NODE_H;
  if (n.type === "document") return n.y + DOC_H;
  return n.y + COMMIT_H;
}
export function nodeMidX(n: GraphNode) {
  if (n.type === "session") return n.x + NODE_W / 2;
  if (n.type === "document") return n.x + DOC_W / 2;
  return n.x + COMMIT_W / 2;
}
export function nodeRight(n: GraphNode) {
  if (n.type === "session") return n.x + NODE_W;
  if (n.type === "document") return n.x + DOC_W;
  return n.x + COMMIT_W;
}
export function nodeMidY(n: GraphNode) {
  if (n.type === "session") return n.y + NODE_H / 2;
  if (n.type === "document") return n.y + DOC_H / 2;
  return n.y + COMMIT_H / 2;
}
