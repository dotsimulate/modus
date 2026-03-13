/**
 * Trace — Turn-level file-touch extraction from stored events.
 *
 * Reads the events table and produces normalized FileTouch records
 * that describe which files a session touched, at what granularity,
 * and with what confidence. This is the backend for the Attention
 * Trace View feature (separate from Session Web provenance).
 *
 * Design: each tool_use event is inspected for file path references.
 * The tool name determines the op and confidence tier.
 */

import { Database } from "bun:sqlite";
import { join, resolve, isAbsolute, extname } from "path";

// ── Types ──

export type FileTouch = {
  sessionId: string;
  seq: number;
  timestamp: number;
  provider: string | null;
  cwd: string | null;
  filePath: string;
  fileKind: "code" | "docs";
  op: "read" | "write" | "edit" | "grep" | "glob" | "ls" | "command" | "mention";
  confidence: "explicit" | "derived" | "heuristic";
  toolName: string;
};

export type TouchQuery = {
  limit?: number;
  userProfile?: string;
  cwd?: string;
  from?: number;
  to?: number;
  ops?: string[];
  confidence?: string[];
  sessionId?: string;
};

// ── File Kind Classification ──

const DOC_EXTS = new Set([
  ".md", ".txt", ".rst", ".adoc", ".org", ".tex",
  ".doc", ".docx", ".pdf", ".rtf",
]);

function classifyFileKind(filePath: string): "code" | "docs" {
  const ext = extname(filePath).toLowerCase();
  return DOC_EXTS.has(ext) ? "docs" : "code";
}

// ── Path Normalization ──

function normalizePath(raw: string, cwd: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "." || trimmed === "/") return null;
  // Skip obvious non-paths
  if (trimmed.includes("\n") || trimmed.length > 500) return null;
  if (isAbsolute(trimmed)) return trimmed;
  if (cwd) return resolve(cwd, trimmed);
  return trimmed;
}

// ── Tool → Touch Mapping ──

type ToolMapping = {
  op: FileTouch["op"];
  confidence: FileTouch["confidence"];
  pathFields: string[];
};

// Claude Code / general SDK tools
const CLAUDE_TOOLS: Record<string, ToolMapping> = {
  Read:       { op: "read",  confidence: "explicit", pathFields: ["file_path"] },
  Write:      { op: "write", confidence: "explicit", pathFields: ["file_path"] },
  Edit:       { op: "edit",  confidence: "explicit", pathFields: ["file_path"] },
  MultiEdit:  { op: "edit",  confidence: "explicit", pathFields: ["file_path"] },
  Grep:       { op: "grep",  confidence: "explicit", pathFields: ["path"] },
  Glob:       { op: "glob",  confidence: "explicit", pathFields: ["path"] },
  Bash:       { op: "command", confidence: "derived", pathFields: [] },
  NotebookEdit: { op: "edit", confidence: "explicit", pathFields: ["file_path", "notebook_path"] },
};

// Codex event-derived tools
const CODEX_TOOLS: Record<string, ToolMapping> = {
  FileChange:       { op: "write", confidence: "derived", pathFields: ["file_path"] },
  CommandExecution:  { op: "command", confidence: "derived", pathFields: [] },
};

// PI Agent tools (lowercase names)
const PI_TOOLS: Record<string, ToolMapping> = {
  read:   { op: "read",  confidence: "explicit", pathFields: ["file_path", "path"] },
  write:  { op: "write", confidence: "explicit", pathFields: ["file_path", "path"] },
  edit:   { op: "edit",  confidence: "explicit", pathFields: ["file_path", "path"] },
  grep:   { op: "grep",  confidence: "explicit", pathFields: ["pattern"] },
  find:   { op: "glob",  confidence: "explicit", pathFields: ["path", "directory"] },
  ls:     { op: "ls",    confidence: "explicit", pathFields: ["path", "directory"] },
  bash:   { op: "command", confidence: "derived", pathFields: [] },
  replace: { op: "edit", confidence: "explicit", pathFields: ["file_path", "path"] },
};

// Gemini tools
const GEMINI_TOOLS: Record<string, ToolMapping> = {
  read_file:       { op: "read",  confidence: "explicit", pathFields: ["path", "file_path"] },
  write_file:      { op: "write", confidence: "explicit", pathFields: ["path", "file_path"] },
  grep_search:     { op: "grep",  confidence: "explicit", pathFields: ["path", "directory"] },
  list_directory:  { op: "ls",    confidence: "explicit", pathFields: ["path", "directory"] },
};

// Merged lookup — order doesn't matter since tool names don't collide
const ALL_TOOLS: Record<string, ToolMapping> = {
  ...CLAUDE_TOOLS,
  ...CODEX_TOOLS,
  ...PI_TOOLS,
  ...GEMINI_TOOLS,
};

// ── Command Parsing (derived confidence) ──

/**
 * Extract file paths from shell commands. Very conservative —
 * only picks up obvious patterns to avoid false positives.
 */
function extractPathsFromCommand(command: string): string[] {
  if (!command || typeof command !== "string") return [];
  const paths: string[] = [];

  // Match: cat/head/tail/less/more <path>
  const readCmds = command.match(/\b(?:cat|head|tail|less|more|wc)\s+(?:-[^\s]+\s+)*([^\s|>&;]+)/g);
  if (readCmds) {
    for (const match of readCmds) {
      const parts = match.split(/\s+/);
      const path = parts[parts.length - 1];
      if (path && !path.startsWith("-")) paths.push(path);
    }
  }

  // Match: vim/nano/code <path>
  const editCmds = command.match(/\b(?:vim|nvim|nano|code|subl)\s+([^\s|>&;]+)/g);
  if (editCmds) {
    for (const match of editCmds) {
      const parts = match.split(/\s+/);
      const path = parts[parts.length - 1];
      if (path && !path.startsWith("-")) paths.push(path);
    }
  }

  return paths;
}

// ── Core Extraction ──

function extractTouchesFromEvent(
  data: any,
  sessionId: string,
  seq: number,
  timestamp: number,
  provider: string | null,
  cwd: string | null,
): FileTouch[] {
  const touches: FileTouch[] = [];

  // Only process assistant events with tool_use content
  if (data.type !== "assistant") return touches;
  const content = data.message?.content;
  if (!Array.isArray(content)) return touches;

  for (const block of content) {
    if (block.type !== "tool_use") continue;

    const toolName: string = block.name ?? "";
    const input: Record<string, unknown> = block.input ?? {};
    const mapping = ALL_TOOLS[toolName];

    if (!mapping) continue;

    // Extract paths from known fields
    const filePaths: string[] = [];
    for (const field of mapping.pathFields) {
      const val = input[field];
      if (typeof val === "string" && val) {
        const normalized = normalizePath(val, cwd);
        if (normalized) filePaths.push(normalized);
      }
    }

    // For command tools, also parse the command string
    if (mapping.op === "command") {
      const cmd = (input.command as string) ?? "";
      for (const p of extractPathsFromCommand(cmd)) {
        const normalized = normalizePath(p, cwd);
        if (normalized) filePaths.push(normalized);
      }
    }

    // Deduplicate paths within this tool call
    const seen = new Set<string>();
    for (const fp of filePaths) {
      if (seen.has(fp)) continue;
      seen.add(fp);
      touches.push({
        sessionId,
        seq,
        timestamp,
        provider,
        cwd,
        filePath: fp,
        fileKind: classifyFileKind(fp),
        op: mapping.op,
        confidence: mapping.confidence,
        toolName,
      });
    }
  }

  return touches;
}

// ── Query Interface ──

/**
 * Extract file touches from the events table.
 * Reads directly from the DB — no caching layer yet.
 */
export function queryTouches(db: Database, query: TouchQuery = {}): FileTouch[] {
  const {
    limit = 5000,
    userProfile,
    cwd: cwdFilter,
    from,
    to,
    ops,
    confidence,
    sessionId,
  } = query;

  // Build SQL to fetch relevant sessions + events
  const conditions: string[] = [];
  const params: Record<string, any> = {};

  if (sessionId) {
    conditions.push("e.session_id = $sessionId");
    params.$sessionId = sessionId;
  }
  if (userProfile) {
    conditions.push("s.user_profile = $userProfile");
    params.$userProfile = userProfile;
  }
  if (cwdFilter) {
    conditions.push("s.cwd LIKE $cwdPrefix");
    params.$cwdPrefix = cwdFilter.replace(/%/g, "\\%") + "%";
  }
  if (from) {
    conditions.push("e.created_at >= $from");
    params.$from = from;
  }
  if (to) {
    conditions.push("e.created_at <= $to");
    params.$to = to;
  }

  // Only fetch assistant events with tool_use content
  conditions.push("e.type = 'assistant'");
  conditions.push("e.data LIKE '%tool_use%'");

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT e.session_id, e.seq, e.data, e.created_at, s.provider, s.cwd
    FROM events e
    JOIN sessions s ON e.session_id = s.id
    ${where}
    ORDER BY e.created_at ASC
  `;

  const rows = db.prepare(sql).all(params) as Array<{
    session_id: string;
    seq: number;
    data: string;
    created_at: number;
    provider: string | null;
    cwd: string | null;
  }>;

  const touches: FileTouch[] = [];
  const opSet = ops ? new Set(ops) : null;
  const confSet = confidence ? new Set(confidence) : null;

  for (const row of rows) {
    let parsed: any;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      continue;
    }

    const extracted = extractTouchesFromEvent(
      parsed,
      row.session_id,
      row.seq,
      row.created_at,
      row.provider,
      row.cwd,
    );

    for (const touch of extracted) {
      if (opSet && !opSet.has(touch.op)) continue;
      if (confSet && !confSet.has(touch.confidence)) continue;
      touches.push(touch);
      if (touches.length >= limit) return touches;
    }
  }

  return touches;
}

/**
 * Summary stats for validation / debugging.
 */
export function touchSummary(touches: FileTouch[]): {
  total: number;
  byOp: Record<string, number>;
  byConfidence: Record<string, number>;
  byProvider: Record<string, number>;
  byFileKind: Record<string, number>;
  uniqueFiles: number;
  uniqueSessions: number;
} {
  const byOp: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const byFileKind: Record<string, number> = {};
  const files = new Set<string>();
  const sessions = new Set<string>();

  for (const t of touches) {
    byOp[t.op] = (byOp[t.op] ?? 0) + 1;
    byConfidence[t.confidence] = (byConfidence[t.confidence] ?? 0) + 1;
    const prov = t.provider ?? "unknown";
    byProvider[prov] = (byProvider[prov] ?? 0) + 1;
    byFileKind[t.fileKind] = (byFileKind[t.fileKind] ?? 0) + 1;
    files.add(t.filePath);
    sessions.add(t.sessionId);
  }

  return {
    total: touches.length,
    byOp,
    byConfidence,
    byProvider,
    byFileKind,
    uniqueFiles: files.size,
    uniqueSessions: sessions.size,
  };
}
