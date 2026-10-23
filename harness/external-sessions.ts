/**
 * External sessions — conversations a provider CLI holds that Modus did not start.
 *
 * Claude Code and Codex each keep every conversation on disk, keyed by an ID
 * their CLI can resume. Modus already resumes by that ID on every turn of its
 * own sessions (`provider_session_id`), so taking over a session started in the
 * CLI, the desktop app, or an IDE is only a matter of finding it and creating a
 * Modus row that points at it. The next turn goes through the provider's normal
 * resume path, and the native file stays the source of truth: anything else
 * resuming the same ID sees the continued thread.
 *
 * Reading is deliberately lenient. Both stores are internal formats, so a record
 * this module does not understand is skipped rather than failing the listing —
 * and a format change can only degrade the imported preview, never the resume,
 * which the provider performs from its own file.
 *
 * The imported history is a readable digest, not a replay: each prompt and the
 * last text the agent wrote after it. Tool calls, injected context, and
 * sub-agent traffic stay in the native file, where the provider still reloads
 * them as context.
 */

import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "fs";
import { open, readdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { isWithinProjectRoot } from "./session-projects";

export const EXTERNAL_SESSION_PROVIDERS = ["claude-code", "codex"] as const;
export type ExternalSessionProvider = typeof EXTERNAL_SESSION_PROVIDERS[number];

export function isExternalSessionProvider(value: unknown): value is ExternalSessionProvider {
  return typeof value === "string" && (EXTERNAL_SESSION_PROVIDERS as readonly string[]).includes(value);
}

export type ExternalSessionSummary = {
  provider: ExternalSessionProvider;
  /** The provider's own conversation ID — what its CLI resumes by. */
  id: string;
  title: string;
  /** Project folder the conversation ran in; resume must run there too. */
  cwd: string | null;
  updatedAt: number;
  /** Where it was started, when the store records it (cli, vscode, exec, …). */
  source?: string;
  /** The native file was written very recently — another front end may still have it open. */
  recentlyActive: boolean;
  /** Set when Modus already has a session for this conversation. */
  modusSessionId?: string;
};

export type ExternalTurn = { role: "user" | "assistant"; text: string; timestamp: number };

export type ExternalTranscript = {
  provider: ExternalSessionProvider;
  id: string;
  title: string;
  cwd: string | null;
  model?: string;
  turns: ExternalTurn[];
};

export type ExternalSessionRoots = {
  /** Claude Code's `projects` directory. */
  claudeProjects: string;
  /** Codex home (holds `state_5.sqlite`). */
  codexHome: string;
};

/**
 * Same roots the resume paths check: `claudeNativeHistoryExists` reads
 * ~/.claude/projects and `canResumeCodexThread` reads CODEX_HOME. Listing from
 * anywhere else would offer sessions the next turn then refuses to resume.
 */
export function defaultExternalSessionRoots(): ExternalSessionRoots {
  return {
    claudeProjects: join(homedir(), ".claude", "projects"),
    codexHome: process.env.CODEX_HOME || join(homedir(), ".codex"),
  };
}

/** A write this recent means another front end may still be appending. */
const RECENT_ACTIVITY_MS = 2 * 60_000;
/** Enough of a transcript's head for its cwd and first prompt, past any attachments. */
const HEAD_BYTES = 256 * 1024;
/** Enough of its tail for the latest title record. */
const TAIL_BYTES = 128 * 1024;
const TITLE_MAX = 120;
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Upper bound on files read for one listing; search and folder filters scan past the page. */
const MAX_SCANNED = 2000;

export type ExternalSessionAvailability = { provider: ExternalSessionProvider; available: boolean };

export function listExternalSessionProviders(
  roots: ExternalSessionRoots = defaultExternalSessionRoots(),
): ExternalSessionAvailability[] {
  return [
    { provider: "claude-code", available: existsSync(roots.claudeProjects) },
    { provider: "codex", available: existsSync(join(roots.codexHome, "state_5.sqlite")) },
  ];
}

export type ListExternalSessionsOptions = {
  provider: ExternalSessionProvider;
  /** Only sessions whose project folder is this folder or inside it. */
  cwd?: string;
  /** Case-insensitive match against title and folder. */
  query?: string;
  limit?: number;
  /** Maps a provider conversation ID to the Modus session already holding it. */
  knownSessions?: Map<string, string>;
  /** Leave out conversations Modus already has. */
  hideKnown?: boolean;
  roots?: ExternalSessionRoots;
  now?: number;
};

export async function listExternalSessions(opts: ListExternalSessionsOptions): Promise<ExternalSessionSummary[]> {
  const roots = opts.roots ?? defaultExternalSessionRoots();
  return opts.provider === "codex"
    ? listCodexSessions(opts, roots)
    : listClaudeSessions(opts, roots);
}

export function readExternalTranscript(
  provider: ExternalSessionProvider,
  id: string,
  roots: ExternalSessionRoots = defaultExternalSessionRoots(),
): ExternalTranscript | null {
  if (!ID_PATTERN.test(id)) return null;
  return provider === "codex" ? readCodexTranscript(id, roots) : readClaudeTranscript(id, roots);
}

// ── Shared ──

function matchesFilters(summary: { title: string; cwd: string | null }, opts: ListExternalSessionsOptions): boolean {
  if (opts.cwd && (!summary.cwd || !isWithinProjectRoot(summary.cwd, opts.cwd))) return false;
  const query = opts.query?.trim().toLowerCase();
  if (query && !`${summary.title}\n${summary.cwd ?? ""}`.toLowerCase().includes(query)) return false;
  return true;
}

function clampLimit(limit: number | undefined): number {
  return Math.min(500, Math.max(1, Math.floor(limit ?? 100)));
}

/** Windows long-path prefix (`\\?\D:\…`) is how Codex records some folders. */
export function cleanExternalCwd(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

function parseLines(text: string, dropFirst: boolean): any[] {
  const lines = text.split("\n");
  // A window that starts mid-file starts mid-line.
  if (dropFirst) lines.shift();
  const records: any[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* partial or foreign line */ }
  }
  return records;
}

async function readWindow(path: string, size: number, fromEnd: boolean, bytes: number): Promise<{ text: string; partial: boolean }> {
  const length = Math.min(size, bytes);
  const position = fromEnd ? size - length : 0;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    return { text: buffer.toString("utf8"), partial: fromEnd && position > 0 };
  } finally {
    await handle.close();
  }
}

/**
 * Collapse a stream of prompts and agent text into prompt/reply pairs.
 *
 * The reply is the text written after the agent's last tool call — what it
 * actually said back — falling back to the last text it wrote in the turn when
 * it ended on a tool call.
 */
class TurnCollector {
  readonly turns: ExternalTurn[] = [];
  private sinceTool = "";
  private lastText = "";
  private replyAt = 0;
  private open = false;

  prompt(text: string, timestamp: number) {
    this.flush();
    this.turns.push({ role: "user", text, timestamp });
    this.open = true;
  }

  text(text: string, timestamp: number) {
    if (!this.open || !text.trim()) return;
    this.sinceTool = this.sinceTool ? `${this.sinceTool}\n\n${text}` : text;
    this.lastText = text;
    this.replyAt = timestamp;
  }

  tool() {
    this.sinceTool = "";
  }

  finish(): ExternalTurn[] {
    this.flush();
    return this.turns;
  }

  private flush() {
    if (!this.open) return;
    const reply = this.sinceTool || this.lastText;
    if (reply) this.turns.push({ role: "assistant", text: reply, timestamp: this.replyAt });
    this.sinceTool = "";
    this.lastText = "";
    this.open = false;
  }
}

function timestampOf(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

// ── Claude Code ──

/** Claude Code names a project folder by replacing every non-alphanumeric character with `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Text Claude Code writes as a user record that the user did not type: slash
 * command wrappers, local command output, reminders, interruption markers.
 */
function isInjectedClaudePrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<")
    || trimmed.startsWith("Caveat:")
    || trimmed.startsWith("[Request interrupted");
}

/** The typed text of a user record, or null for tool results and injected context. */
function claudePromptText(record: any): string | null {
  if (record?.type !== "user" || record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  if (record.isVisibleInTranscriptOnly) return null;
  const content = record.message?.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some((block: any) => block?.type === "tool_result")) return null;
    text = content
      .filter((block: any) => block?.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text)
      .join("\n");
  }
  if (!text.trim() || isInjectedClaudePrompt(text)) return null;
  return text;
}

function claudeTitle(records: any[]): string | null {
  let custom: string | null = null;
  let generated: string | null = null;
  for (const record of records) {
    if (record?.type === "custom-title" && typeof record.customTitle === "string" && record.customTitle.trim()) custom = record.customTitle;
    if (record?.type === "ai-title" && typeof record.aiTitle === "string" && record.aiTitle.trim()) generated = record.aiTitle;
    if (record?.type === "summary" && typeof record.summary === "string" && record.summary.trim()) generated = record.summary;
  }
  return custom ?? generated;
}

async function listClaudeSessions(
  opts: ListExternalSessionsOptions,
  roots: ExternalSessionRoots,
): Promise<ExternalSessionSummary[]> {
  const limit = clampLimit(opts.limit);
  const now = opts.now ?? Date.now();
  // The folder name is lossy (`a-b` and `a\b` encode alike), so it only narrows
  // the scan; each candidate's real cwd is checked from inside the file.
  const dirPrefix = opts.cwd ? claudeProjectDirName(opts.cwd).toLowerCase() : null;

  let dirs: string[];
  try {
    dirs = (await readdir(roots.claudeProjects, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !dirPrefix || name.toLowerCase() === dirPrefix || name.toLowerCase().startsWith(`${dirPrefix}-`));
  } catch {
    return [];
  }

  const files: { id: string; path: string; size: number; mtime: number }[] = [];
  await Promise.all(dirs.map(async (dir) => {
    let names: string[];
    try { names = await readdir(join(roots.claudeProjects, dir)); } catch { return; }
    await Promise.all(names.map(async (name) => {
      if (!name.endsWith(".jsonl")) return;
      const id = name.slice(0, -".jsonl".length);
      if (!ID_PATTERN.test(id)) return;
      const path = join(roots.claudeProjects, dir, name);
      try {
        const info = await stat(path);
        if (info.isFile() && info.size > 0) files.push({ id, path, size: info.size, mtime: info.mtimeMs });
      } catch { /* vanished between readdir and stat */ }
    }));
  }));
  files.sort((a, b) => b.mtime - a.mtime);

  const results: ExternalSessionSummary[] = [];
  let scanned = 0;
  for (const file of files) {
    if (results.length >= limit || scanned >= MAX_SCANNED) break;
    const modusSessionId = opts.knownSessions?.get(file.id);
    if (modusSessionId && opts.hideKnown) continue;
    scanned++;
    const summary = await summarizeClaudeFile(file, now).catch(() => null);
    if (!summary) continue;
    if (!matchesFilters(summary, opts)) continue;
    results.push(modusSessionId ? { ...summary, modusSessionId } : summary);
  }
  return results;
}

async function summarizeClaudeFile(
  file: { id: string; path: string; size: number; mtime: number },
  now: number,
): Promise<ExternalSessionSummary | null> {
  const head = await readWindow(file.path, file.size, false, HEAD_BYTES);
  const headRecords = parseLines(head.text, false);
  let cwd: string | null = null;
  let firstPrompt: string | null = null;
  let source: string | undefined;
  for (const record of headRecords) {
    if (!cwd && !record?.isSidechain) cwd = cleanExternalCwd(record?.cwd);
    if (!source && typeof record?.entrypoint === "string") source = record.entrypoint;
    if (!firstPrompt) firstPrompt = claudePromptText(record);
    if (cwd && firstPrompt && source) break;
  }
  // A file with no typed prompt is a stub (an aborted start, a sub-agent log).
  if (!firstPrompt) return null;
  const tail = file.size > HEAD_BYTES
    ? parseLines((await readWindow(file.path, file.size, true, TAIL_BYTES)).text, true)
    : headRecords;
  const title = claudeTitle(tail) ?? claudeTitle(headRecords) ?? firstPrompt;
  return {
    provider: "claude-code",
    id: file.id,
    title: oneLine(title),
    cwd,
    updatedAt: file.mtime,
    ...(source ? { source } : {}),
    recentlyActive: now - file.mtime < RECENT_ACTIVITY_MS,
  };
}

export function findClaudeTranscriptPath(id: string, projectsRoot: string): string | null {
  if (!ID_PATTERN.test(id)) return null;
  try {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projectsRoot, entry.name, `${id}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* no Claude state */ }
  return null;
}

/**
 * The conversation `--resume` will load: the chain of parents from the latest
 * message. Reading the file top to bottom would also show branches abandoned by
 * a rewind, which the resumed session no longer contains.
 */
export function claudeActiveChain(records: any[]): any[] {
  const byUuid = new Map<string, any>();
  let leaf: any = null;
  for (const record of records) {
    if (typeof record?.uuid !== "string") continue;
    byUuid.set(record.uuid, record);
    if ((record.type === "user" || record.type === "assistant") && !record.isSidechain) leaf = record;
  }
  if (!leaf) return [];
  const chain: any[] = [];
  const seen = new Set<string>();
  let cursor: any = leaf;
  while (cursor && !seen.has(cursor.uuid)) {
    seen.add(cursor.uuid);
    chain.push(cursor);
    // Compaction starts a new root that names its predecessor logically.
    const parent = cursor.parentUuid ?? cursor.logicalParentUuid;
    cursor = typeof parent === "string" ? byUuid.get(parent) : null;
  }
  return chain.reverse();
}

export function parseClaudeTranscript(id: string, text: string): ExternalTranscript {
  const records = parseLines(text, false);
  const chain = claudeActiveChain(records);
  const collector = new TurnCollector();
  let cwd: string | null = null;
  let model: string | undefined;
  let fallbackAt = 0;
  for (const record of chain) {
    const at = timestampOf(record.timestamp, fallbackAt);
    fallbackAt = at;
    if (!cwd) cwd = cleanExternalCwd(record.cwd);
    const prompt = claudePromptText(record);
    if (prompt) {
      collector.prompt(prompt, at);
      continue;
    }
    if (record.type !== "assistant" || record.isSidechain) continue;
    if (typeof record.message?.model === "string" && record.message.model !== "<synthetic>") model = record.message.model;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") collector.tool();
      if (block?.type === "text" && typeof block.text === "string") collector.text(block.text, at);
    }
  }
  const turns = collector.finish();
  const firstPrompt = turns.find((turn) => turn.role === "user")?.text ?? "";
  return {
    provider: "claude-code",
    id,
    title: oneLine(claudeTitle(records) ?? firstPrompt),
    cwd,
    ...(model ? { model } : {}),
    turns,
  };
}

function readClaudeTranscript(id: string, roots: ExternalSessionRoots): ExternalTranscript | null {
  const path = findClaudeTranscriptPath(id, roots.claudeProjects);
  if (!path) return null;
  try {
    return parseClaudeTranscript(id, readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── Codex ──

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  cwd: string;
  title: string | null;
  name: string | null;
  first_user_message: string | null;
  preview: string | null;
  updated_at: number;
  updated_at_ms: number | null;
  source: string | null;
  model: string | null;
};

/**
 * Threads a person started. Modus's own threads carry its originator, and
 * sub-agent threads are part of a parent conversation rather than one to resume.
 */
const CODEX_THREAD_COLUMNS = "id, rollout_path, cwd, title, name, first_user_message, preview, updated_at, updated_at_ms, source, model";

const CODEX_THREAD_QUERY = `
  SELECT ${CODEX_THREAD_COLUMNS}
  FROM threads
  WHERE archived = 0
    AND (originator IS NULL OR originator != 'modus_harness')
    AND source NOT LIKE '{%'
    AND (thread_source IS NULL OR thread_source != 'subagent')
  ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
  LIMIT $limit
`;

/**
 * Run one read against Codex's live state database and let go of it.
 *
 * The statement is finalized before closing: Bun defers closing a database
 * that still has statements alive, and a handle left open on Windows locks the
 * file Codex itself is writing.
 */
function readCodexState<T>(roots: ExternalSessionRoots, sql: string, read: (statement: ReturnType<Database["prepare"]>) => T): T | null {
  const path = join(roots.codexHome, "state_5.sqlite");
  if (!existsSync(path)) return null;
  let db: Database | null = null;
  let statement: ReturnType<Database["prepare"]> | null = null;
  try {
    db = new Database(path, { readonly: true });
    statement = db.prepare(sql);
    return read(statement);
  } catch {
    return null;
  } finally {
    try { statement?.finalize(); } catch { /* ignore */ }
    try { db?.close(); } catch { /* ignore */ }
  }
}

function codexThreadTitle(row: CodexThreadRow): string {
  for (const candidate of [row.name, row.title, row.first_user_message, row.preview]) {
    if (typeof candidate === "string" && candidate.trim()) return oneLine(candidate);
  }
  return row.id;
}

async function listCodexSessions(
  opts: ListExternalSessionsOptions,
  roots: ExternalSessionRoots,
): Promise<ExternalSessionSummary[]> {
  const limit = clampLimit(opts.limit);
  const now = opts.now ?? Date.now();
  const rows = readCodexState(roots, CODEX_THREAD_QUERY, (statement) => statement.all({ $limit: MAX_SCANNED }) as CodexThreadRow[]) ?? [];

  const results: ExternalSessionSummary[] = [];
  for (const row of rows) {
    if (results.length >= limit) break;
    const modusSessionId = opts.knownSessions?.get(row.id);
    if (modusSessionId && opts.hideKnown) continue;
    const updatedAt = row.updated_at_ms ?? row.updated_at * 1000;
    const summary: ExternalSessionSummary = {
      provider: "codex",
      id: row.id,
      title: codexThreadTitle(row),
      cwd: cleanExternalCwd(row.cwd),
      updatedAt,
      ...(row.source ? { source: row.source } : {}),
      recentlyActive: now - updatedAt < RECENT_ACTIVITY_MS,
      ...(modusSessionId ? { modusSessionId } : {}),
    };
    if (!matchesFilters(summary, opts)) continue;
    results.push(summary);
  }
  return results;
}

/** Context Codex injects as user messages: environment, instructions, AGENTS.md. */
function isInjectedCodexPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<") || trimmed.startsWith("# AGENTS.md");
}

function codexMessageText(content: unknown, kind: "input_text" | "output_text"): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block?.type === kind && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n");
}

export function parseCodexTranscript(id: string, text: string, meta: { title?: string; cwd?: string | null; model?: string | null } = {}): ExternalTranscript {
  const collector = new TurnCollector();
  let cwd = meta.cwd ?? null;
  let fallbackAt = 0;
  for (const record of parseLines(text, false)) {
    const at = timestampOf(record?.timestamp, fallbackAt);
    fallbackAt = at;
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (record.type === "session_meta" && !cwd) cwd = cleanExternalCwd(payload.cwd);
    if (record.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const prompt = codexMessageText(payload.content, "input_text");
      if (prompt.trim() && !isInjectedCodexPrompt(prompt)) collector.prompt(prompt, at);
    } else if (payload.type === "message" && payload.role === "assistant") {
      collector.text(codexMessageText(payload.content, "output_text"), at);
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "local_shell_call") {
      collector.tool();
    }
  }
  const turns = collector.finish();
  const firstPrompt = turns.find((turn) => turn.role === "user")?.text ?? "";
  return {
    provider: "codex",
    id,
    title: oneLine(meta.title || firstPrompt),
    cwd,
    ...(meta.model ? { model: meta.model } : {}),
    turns,
  };
}

function readCodexTranscript(id: string, roots: ExternalSessionRoots): ExternalTranscript | null {
  const row = readCodexState(
    roots,
    `SELECT ${CODEX_THREAD_COLUMNS} FROM threads WHERE id = $id LIMIT 1`,
    (statement) => statement.get({ $id: id }) as CodexThreadRow | null,
  );
  if (!row?.rollout_path || !existsSync(row.rollout_path)) return null;
  try {
    return parseCodexTranscript(id, readFileSync(row.rollout_path, "utf8"), {
      title: codexThreadTitle(row),
      cwd: cleanExternalCwd(row.cwd),
      model: row.model,
    });
  } catch {
    return null;
  }
}
