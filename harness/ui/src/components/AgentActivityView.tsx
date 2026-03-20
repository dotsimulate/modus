/**
 * AgentActivityView — live activity feed of all tool calls in the current session.
 *
 * Architecture:
 *   - Card registry maps tool names → visual components (component-driven, modular)
 *   - Feed collects ALL tool calls across ALL messages (not just the latest)
 *   - Clicking a card scrolls the chat to that tool call
 *   - Order is configurable: set NEWEST_FIRST to flip
 */

import { useMemo, useEffect, useRef, type ReactNode } from "react";
import type { Message, ToolCall } from "../api";

// ── Config ──

/** Set to true for newest-at-top feed order */
const NEWEST_FIRST = true;

// ── Types ──

type FeedItem = {
  tool: ToolCall;
  msgIndex: number;
};

type ToolCardProps = {
  tool: ToolCall;
};

type ToolCardComponent = (props: ToolCardProps) => ReactNode;

// ── Utility ──

function shortPath(s: string): string {
  return s.replace(/^\/home\/[^/]+\//, "~/");
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function dirOf(fp: string): string {
  const name = basename(fp);
  const dir = fp.slice(0, fp.length - name.length - 1);
  return dir ? shortPath(dir) : "";
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\u2026" : s;
}

function unwrapResult(s: string): string {
  if (s.startsWith('"') || s.startsWith("[") || s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === "string") return parsed;
      if (Array.isArray(parsed)) {
        return parsed
          .map((b: any) => (typeof b === "string" ? b : b.text ?? JSON.stringify(b)))
          .join("\n");
      }
      if (parsed && Array.isArray(parsed.content)) {
        return parsed.content
          .map((b: any) => (typeof b === "string" ? b : b.text ?? JSON.stringify(b)))
          .join("\n");
      }
    } catch { /* not JSON */ }
  }
  return s;
}

function countLines(s: string): number {
  if (!s) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++;
  return n;
}

function previewLines(s: string, n: number): string {
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return lines.slice(0, n).join("\n");
}

function countDiffChanges(old_str: string, new_str: string): { adds: number; dels: number } {
  const oldLines = (old_str || "").split("\n").length;
  const newLines = (new_str || "").split("\n").length;
  return { adds: Math.max(0, newLines - oldLines), dels: Math.max(0, oldLines - newLines) };
}

// ── Scroll-to-chat ──

function scrollChatToTool(toolId: string) {
  const el = document.querySelector(`[data-tool-id="${toolId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("aa-highlight-pulse");
    setTimeout(() => el.classList.remove("aa-highlight-pulse"), 1200);
  }
}

// ── Icons ──
// Each returns a tiny colored SVG. Kept here so card components stay clean.

const Icons = {
  read: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M1 6s2.2-3 5-3 5 3 5 3-2.2 3-5 3-5-3-5-3z" stroke="#5a9bcf" strokeWidth="1.2"/>
      <circle cx="6" cy="6" r="1.3" fill="#5a9bcf"/>
    </svg>
  ),
  edit: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M8.5 1.5l2 2L4 10H2v-2l6.5-6.5z" stroke="#e89b50" strokeWidth="1.1" strokeLinejoin="round"/>
    </svg>
  ),
  write: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M6 2v8M2 6h8" stroke="#33cc33" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  bash: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M2 3l3 3-3 3" stroke="#888" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M7 9h3" stroke="#888" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  ),
  search: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <circle cx="5.2" cy="5.2" r="3" stroke="#9977dd" strokeWidth="1.2"/>
      <path d="M7.5 7.5l2.5 2.5" stroke="#9977dd" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  ),
  glob: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M1 3.5h4l1-1.5h5v8H1z" stroke="#6a9a6a" strokeWidth="1.1" fill="none"/>
    </svg>
  ),
  agent: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="3.5" r="2" stroke="#b44dff" strokeWidth="1.1"/>
      <path d="M2.5 10.5c0-1.8 1.6-3.2 3.5-3.2s3.5 1.4 3.5 3.2" stroke="#b44dff" strokeWidth="1.1" strokeLinecap="round"/>
    </svg>
  ),
  todo: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" stroke="#33cc33" strokeWidth="1.1"/>
      <path d="M3.5 6l2 2 3-4" stroke="#33cc33" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
  mcp: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="2" stroke="#5090ff" strokeWidth="1.1"/>
      <path d="M6 1v2.5M6 8.5V11M1 6h2.5M8.5 6H11" stroke="#5090ff" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  ),
  web: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <circle cx="6" cy="6" r="4.2" stroke="#cc5588" strokeWidth="1"/>
      <ellipse cx="6" cy="6" rx="2" ry="4.2" stroke="#cc5588" strokeWidth="0.9"/>
      <path d="M1.8 6h8.4" stroke="#cc5588" strokeWidth="0.9"/>
    </svg>
  ),
  skill: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <path d="M6 1l1.5 3.5H11L8 7l1 3.5L6 8.5 3 10.5l1-3.5L1 4.5h3.5z" stroke="#e89b50" strokeWidth="1" strokeLinejoin="round"/>
    </svg>
  ),
  generic: (
    <svg className="aa-svg" viewBox="0 0 12 12" fill="none">
      <rect x="2" y="2" width="8" height="8" rx="1.5" stroke="#666" strokeWidth="1.1"/>
    </svg>
  ),
};

// ── Card Components ──

function ReadCard({ tool }: ToolCardProps) {
  const fp = (tool.input.file_path as string) ?? (tool.input.path as string) ?? "";
  const offset = tool.input.offset as number | undefined;
  const limit = tool.input.limit as number | undefined;
  const text = tool.result ? unwrapResult(tool.result) : null;
  const lineCount = text ? countLines(text) : null;

  const rangeLabel = offset && limit
    ? `L${offset}\u2013${offset + limit}`
    : offset ? `L${offset}+` : limit ? `${limit}L` : "";

  const preview = text ? previewLines(text, 4) : null;
  const dir = dirOf(fp);

  return (
    <div className="aa-card aa-card--read">
      <div className="aa-card-row">
        {Icons.read}
        <span className="aa-file" title={fp}>{basename(fp)}</span>
        {dir && <span className="aa-dir" title={fp}>{dir}</span>}
        {rangeLabel && <span className="aa-tag">{rangeLabel}</span>}
        {lineCount != null && <span className="aa-tag">{lineCount}L</span>}
        <ToolStatus tool={tool} />
      </div>
      {preview && (
        <pre className="aa-snippet">{preview}{lineCount! > 4 ? `\n\u2026 ${lineCount! - 4} more` : ""}</pre>
      )}
    </div>
  );
}

function EditCard({ tool }: ToolCardProps) {
  const fp = (tool.input.file_path as string) ?? "";
  const isWrite = tool.name === "Write" || tool.name === "write";

  let adds = 0, dels = 0, editCount = 0;
  if (isWrite) {
    adds = countLines((tool.input.content as string) ?? "");
    editCount = 1;
  } else if (tool.name === "MultiEdit" && Array.isArray(tool.input.edits)) {
    editCount = (tool.input.edits as any[]).length;
    for (const e of tool.input.edits as Array<{ old_string?: string; new_string?: string }>) {
      const d = countDiffChanges(e.old_string ?? "", e.new_string ?? "");
      adds += d.adds; dels += d.dels;
    }
  } else {
    editCount = 1;
    const d = countDiffChanges((tool.input.old_string as string) ?? "", (tool.input.new_string as string) ?? "");
    adds = d.adds; dels = d.dels;
  }

  const showPreview = !isWrite && editCount === 1;
  const oldStr = (tool.input.old_string as string) ?? "";
  const newStr = (tool.input.new_string as string) ?? "";
  const dir = dirOf(fp);

  return (
    <div className="aa-card aa-card--edit">
      <div className="aa-card-row">
        {isWrite ? Icons.write : Icons.edit}
        <span className="aa-file" title={fp}>{basename(fp)}</span>
        {dir && <span className="aa-dir" title={fp}>{dir}</span>}
        {editCount > 1 && <span className="aa-tag">{editCount} edits</span>}
        {adds > 0 && <span className="aa-diff-stat aa-diff-stat--add">+{adds}</span>}
        {dels > 0 && <span className="aa-diff-stat aa-diff-stat--del">{"\u2212"}{dels}</span>}
        <ToolStatus tool={tool} />
      </div>
      {showPreview && (oldStr || newStr) && (
        <div className="aa-inline-diff">
          {oldStr && <pre className="aa-diff-line aa-diff-line--del">{"\u2212"} {previewLines(oldStr, 2)}</pre>}
          {newStr && <pre className="aa-diff-line aa-diff-line--add">+ {previewLines(newStr, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

function BashCard({ tool }: ToolCardProps) {
  const cmd = (tool.input.command as string) ?? "";
  const desc = (tool.input.description as string) ?? "";

  return (
    <div className="aa-card aa-card--bash">
      <div className="aa-card-row">
        {Icons.bash}
        <span className="aa-cmd">{truncate(desc || cmd, 70)}</span>
        <ToolStatus tool={tool} />
      </div>
      {tool.result && (
        <pre className="aa-snippet aa-snippet--dim">{previewLines(unwrapResult(tool.result), 3)}</pre>
      )}
    </div>
  );
}

function GrepCard({ tool }: ToolCardProps) {
  const pattern = (tool.input.pattern as string) ?? "";
  const path = (tool.input.path as string) ?? "";
  const result = tool.result ? unwrapResult(tool.result) : "";
  const matchCount = result ? result.split("\n").filter(Boolean).length : null;

  return (
    <div className="aa-card aa-card--grep">
      <div className="aa-card-row">
        {Icons.search}
        <span className="aa-pattern">/{pattern}/</span>
        {path && <span className="aa-dir">{basename(path)}</span>}
        {matchCount != null && <span className="aa-tag">{matchCount} hits</span>}
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function GlobCard({ tool }: ToolCardProps) {
  const pattern = (tool.input.pattern as string) ?? "";
  const path = (tool.input.path as string) ?? "";
  const result = tool.result ? unwrapResult(tool.result) : "";
  const fileCount = result ? result.split("\n").filter(Boolean).length : null;

  return (
    <div className="aa-card aa-card--glob">
      <div className="aa-card-row">
        {Icons.glob}
        <span className="aa-cmd">{pattern}</span>
        {path && <span className="aa-dir">{basename(path)}</span>}
        {fileCount != null && <span className="aa-tag">{fileCount} files</span>}
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function AgentCard({ tool }: ToolCardProps) {
  const desc = (tool.input.description as string) ?? "";
  const subCount = tool.subMessages?.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0) ?? 0;

  return (
    <div className="aa-card aa-card--agent">
      <div className="aa-card-row">
        {Icons.agent}
        <span className="aa-cmd">{truncate(desc, 55)}</span>
        {subCount > 0 && <span className="aa-tag">{subCount} calls</span>}
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function TodoCard({ tool }: ToolCardProps) {
  const raw = tool.input.todos;
  const todos = Array.isArray(raw) ? raw as Array<{ content: string; status: string }> : null;
  if (!todos?.length) return null;
  const done = todos.filter(t => t.status === "completed").length;
  const total = todos.length;

  return (
    <div className="aa-card aa-card--todo">
      <div className="aa-card-row">
        {Icons.todo}
        <span className="aa-cmd">tasks</span>
        <span className="aa-tag">{done}/{total}</span>
        <ToolStatus tool={tool} />
      </div>
      <div className="aa-todo-bar">
        <div className="aa-todo-fill" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    </div>
  );
}

function McpCard({ tool }: ToolCardProps) {
  const parts = tool.name.split("__");
  const server = parts[1] ?? "";
  const method = parts[2] ?? "";

  return (
    <div className="aa-card aa-card--mcp">
      <div className="aa-card-row">
        {Icons.mcp}
        <span className="aa-cmd">{server}<span className="aa-sep">/</span>{method}</span>
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function WebCard({ tool }: ToolCardProps) {
  const query = (tool.input.query as string) ?? (tool.input.url as string) ?? "";

  return (
    <div className="aa-card aa-card--web">
      <div className="aa-card-row">
        {Icons.web}
        <span className="aa-cmd">{truncate(query, 55)}</span>
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function SkillCard({ tool }: ToolCardProps) {
  const skill = (tool.input.skill as string) ?? "";

  return (
    <div className="aa-card aa-card--skill">
      <div className="aa-card-row">
        {Icons.skill}
        <span className="aa-cmd">/{skill}</span>
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

function GenericCard({ tool }: ToolCardProps) {
  const summary = toolSummary(tool);

  return (
    <div className="aa-card aa-card--generic">
      <div className="aa-card-row">
        {Icons.generic}
        <span className="aa-cmd">{displayToolName(tool.name)}</span>
        {summary && <span className="aa-dir">{summary}</span>}
        <ToolStatus tool={tool} />
      </div>
    </div>
  );
}

// ── Shared sub-components ──

function ToolStatus({ tool }: { tool: ToolCall }) {
  return (
    <span className="aa-status">
      {tool.status === "running" && <span className="tool-spinner" />}
      {tool.status === "completed" && tool.duration != null && (
        <span className="aa-dur">{(tool.duration / 1000).toFixed(1)}s</span>
      )}
      {tool.status === "error" && <span className="aa-err">err</span>}
    </span>
  );
}

// ── Card Registry ──

const CARD_REGISTRY: Record<string, ToolCardComponent> = {
  Read: ReadCard,
  read: ReadCard,
  Edit: EditCard,
  edit: EditCard,
  Write: EditCard,
  write: EditCard,
  MultiEdit: EditCard,
  FileChange: EditCard,
  Bash: BashCard,
  bash: BashCard,
  CommandExecution: BashCard,
  Grep: GrepCard,
  grep: GrepCard,
  Glob: GlobCard,
  Agent: AgentCard,
  TodoWrite: TodoCard,
  WebSearch: WebCard,
  WebFetch: WebCard,
  Skill: SkillCard,
};

function getCard(toolName: string): ToolCardComponent {
  if (toolName.startsWith("mcp__")) return McpCard;
  return CARD_REGISTRY[toolName] ?? GenericCard;
}

// ── Helpers ──

function displayToolName(name: string): string {
  if (name === "CommandExecution") return "command";
  if (name === "FileChange") return "file change";
  if (name === "WebSearch") return "web search";
  if (name === "MCPToolCall") return "mcp tool";
  if (name === "Skill") return "skill";
  return name.toLowerCase();
}

function toolSummary(tool: ToolCall): string {
  const inp = tool.input;
  const fp = (inp.file_path as string) ?? (inp.path as string);
  if (fp) return shortPath(fp);
  if (inp.skill) return inp.skill as string;
  if (inp.query) return truncate(inp.query as string, 40);
  if (inp.url) return truncate(inp.url as string, 40);
  return "";
}

// ── Extraction ──

function collectAllToolCalls(messages: Message[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tool of msg.toolCalls) {
        items.push({ tool, msgIndex: i });
      }
    }
  }
  return items;
}

// ── Main Component ──

type Props = {
  messages: Message[];
};

export function AgentActivityView({ messages }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const feed = useMemo(() => {
    const items = collectAllToolCalls(messages);
    return NEWEST_FIRST ? items.slice().reverse() : items;
  }, [messages]);

  useEffect(() => {
    if (feed.length > prevCountRef.current && NEWEST_FIRST) {
      scrollRef.current?.scrollTo({ top: 0 });
    }
    prevCountRef.current = feed.length;
  }, [feed.length]);

  if (feed.length === 0) {
    return (
      <div className="aa-empty">
        <svg className="aa-empty-icon" width="20" height="20" viewBox="0 0 12 12" fill="none">
          <path d="M1 6h2l1.5-3 2 6L8.5 3 10 6h1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span>no activity yet</span>
      </div>
    );
  }

  return (
    <div className="aa-feed" ref={scrollRef}>
      {feed.map((item) => {
        const Card = getCard(item.tool.name);
        return (
          <div
            key={item.tool.id}
            className={`aa-feed-item${item.tool.status === "running" ? " aa-feed-item--active" : ""}`}
            onClick={() => scrollChatToTool(item.tool.id)}
          >
            <Card tool={item.tool} />
          </div>
        );
      })}
    </div>
  );
}
