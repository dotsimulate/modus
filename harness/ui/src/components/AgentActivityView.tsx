/**
 * AgentActivityView — live activity feed of all tool calls in the current session.
 *
 * Architecture:
 *   - Card registry maps tool names → visual components (component-driven, modular)
 *   - Feed collects ALL tool calls across ALL messages (not just the latest)
 *   - Clicking a card scrolls the chat to that tool call
 *   - Order is configurable: set NEWEST_FIRST to flip
 */

import { useMemo, useEffect, useRef, useState, type ReactNode } from "react";
import type { Message, ToolCall } from "../../../sdk/index";

// ── Config ──

/** Set to true for newest-at-top feed order */
const NEWEST_FIRST = true;

// ── Types ──

type FeedItem = {
  tool: ToolCall;
  msgIndex: number;
  anchorId: string;
};

type ToolCardProps = {
  tool: ToolCall;
  expanded: boolean;
  toggleControl?: (icon: ReactNode) => ReactNode;
  /** Ms from last user message in this turn to tool result (completed/error); null if unknown */
  intoTurnMs: number | null;
};

type ToolCardRender = {
  summary: ReactNode;
  detail?: ReactNode;
};

type ToolCardComponent = (props: ToolCardProps) => ToolCardRender;

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

/** Epoch ms of the last user message before this assistant message (turn anchor). */
function lastUserTimestampBefore(messages: Message[], beforeIndex: number): number | undefined {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && m.timestamp != null) return m.timestamp;
  }
  return undefined;
}

/** Elapsed from turn start to tool completion; null if anchor or finish time missing. */
function intoTurnMsForTool(messages: Message[], msgIndex: number, tool: ToolCall): number | null {
  if (tool.status === "running") return null;
  const anchor = lastUserTimestampBefore(messages, msgIndex);
  if (anchor == null) return null;
  const finishMs = tool.startedAt + (tool.duration ?? 0);
  return Math.max(0, finishMs - anchor);
}

function formatIntoTurn(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m > 0) return `+${m}:${s.toString().padStart(2, "0")}`;
  return `+${sec}s`;
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

function countDiffChanges(old_str: string, new_str: string): { adds: number; dels: number } {
  const oldLines = (old_str || "").split("\n").length;
  const newLines = (new_str || "").split("\n").length;
  return { adds: Math.max(0, newLines - oldLines), dels: Math.max(0, oldLines - newLines) };
}

// ── Scroll-to-chat ──

function scrollChatToTool(anchorId: string, toolId: string) {
  const el = document.querySelector(`[data-tool-anchor="${anchorId}"]`)
    ?? document.querySelector(`[data-tool-id="${toolId}"]`);
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

function ReadCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const fp = (tool.input.file_path as string) ?? (tool.input.path as string) ?? "";
  const offset = tool.input.offset as number | undefined;
  const limit = tool.input.limit as number | undefined;
  const text = tool.result ? unwrapResult(tool.result) : null;
  const lineCount = text ? countLines(text) : null;

  const rangeLabel = offset && limit
    ? `L${offset}\u2013${offset + limit}`
    : offset ? `L${offset}+` : limit ? `${limit}L` : "";

  const dir = dirOf(fp);

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.read) : Icons.read}
        <span className="aa-file" title={fp}>{basename(fp)}</span>
        {dir && <span className="aa-dir" title={fp}>{dir}</span>}
        {rangeLabel && <span className="aa-tag">{rangeLabel}</span>}
        {lineCount != null && <span className="aa-tag">{lineCount}L</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
    detail: text ? (
      <pre className="aa-snippet aa-snippet--full">{text}</pre>
    ) : undefined,
  };
}

function EditCard({ tool, expanded, toggleControl, intoTurnMs }: ToolCardProps) {
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

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(isWrite ? Icons.write : Icons.edit) : (isWrite ? Icons.write : Icons.edit)}
        <span className="aa-file" title={fp}>{basename(fp)}</span>
        {dir && <span className="aa-dir" title={fp}>{dir}</span>}
        {editCount > 1 && <span className="aa-tag">{editCount} edits</span>}
        {adds > 0 && <span className="aa-diff-stat aa-diff-stat--add">+{adds}</span>}
        {dels > 0 && <span className="aa-diff-stat aa-diff-stat--del">{"\u2212"}{dels}</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
    detail: (showPreview && (oldStr || newStr)) || (isWrite && expanded && (tool.input.content as string))
      ? (
        <div className="aa-inline-diff">
          {oldStr && <pre className="aa-diff-line aa-diff-line--del">{"\u2212"} {oldStr}</pre>}
          {newStr && <pre className="aa-diff-line aa-diff-line--add">+ {newStr}</pre>}
          {isWrite && (tool.input.content as string) && (
            <pre className="aa-diff-line aa-diff-line--add">+ {tool.input.content as string}</pre>
          )}
        </div>
      ) : undefined,
  };
}

function BashCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const cmd = (tool.input.command as string) ?? "";
  const desc = (tool.input.description as string) ?? "";

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.bash) : Icons.bash}
        <span className="aa-cmd">{truncate(desc || cmd, 70)}</span>
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
    detail: tool.result ? (
      <pre className="aa-snippet aa-snippet--dim aa-snippet--full">{unwrapResult(tool.result)}</pre>
    ) : undefined,
  };
}

function GrepCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const pattern = (tool.input.pattern as string) ?? "";
  const path = (tool.input.path as string) ?? "";
  const result = tool.result ? unwrapResult(tool.result) : "";
  const matchCount = result ? result.split("\n").filter(Boolean).length : null;

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.search) : Icons.search}
        <span className="aa-pattern">/{pattern}/</span>
        {path && <span className="aa-dir">{basename(path)}</span>}
        {matchCount != null && <span className="aa-tag">{matchCount} hits</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function GlobCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const pattern = (tool.input.pattern as string) ?? "";
  const path = (tool.input.path as string) ?? "";
  const result = tool.result ? unwrapResult(tool.result) : "";
  const fileCount = result ? result.split("\n").filter(Boolean).length : null;

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.glob) : Icons.glob}
        <span className="aa-cmd">{pattern}</span>
        {path && <span className="aa-dir">{basename(path)}</span>}
        {fileCount != null && <span className="aa-tag">{fileCount} files</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function AgentCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const desc = (tool.input.description as string) ?? "";
  const subCount = tool.subMessages?.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0) ?? 0;

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.agent) : Icons.agent}
        <span className="aa-cmd">{truncate(desc, 55)}</span>
        {subCount > 0 && <span className="aa-tag">{subCount} calls</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function TodoCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const raw = tool.input.todos;
  const todos = Array.isArray(raw) ? raw as Array<{ content: string; status: string }> : null;
  if (!todos?.length) return { summary: null };
  const done = todos.filter(t => t.status === "completed").length;
  const total = todos.length;

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.todo) : Icons.todo}
        <span className="aa-cmd">tasks</span>
        <span className="aa-tag">{done}/{total}</span>
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
    detail: (
      <>
        <div className="aa-todo-bar">
          <div className="aa-todo-fill" style={{ width: `${(done / total) * 100}%` }} />
        </div>
        <div className="aa-todo-list">
          {todos.map((todo, index) => (
            <div key={index} className={`aa-todo-item aa-todo-item--${todo.status}`}>
              {todo.content}
            </div>
          ))}
        </div>
      </>
    ),
  };
}

function McpCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const parts = tool.name.split("__");
  const server = parts[1] ?? "";
  const method = parts[2] ?? "";

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.mcp) : Icons.mcp}
        <span className="aa-cmd">{server}<span className="aa-sep">/</span>{method}</span>
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function WebCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const query = (tool.input.query as string) ?? (tool.input.url as string) ?? "";

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.web) : Icons.web}
        <span className="aa-cmd">{truncate(query, 55)}</span>
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function SkillCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const skill = (tool.input.skill as string) ?? "";

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.skill) : Icons.skill}
        <span className="aa-cmd">/{skill}</span>
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

function GenericCard({ tool, toggleControl, intoTurnMs }: ToolCardProps) {
  const summary = toolSummary(tool);

  return {
    summary: (
      <div className="aa-card-row">
        {toggleControl ? toggleControl(Icons.generic) : Icons.generic}
        <span className="aa-cmd">{displayToolName(tool.name)}</span>
        {summary && <span className="aa-dir">{summary}</span>}
        <ToolStatus tool={tool} intoTurnMs={intoTurnMs} />
      </div>
    ),
  };
}

// ── Shared sub-components ──

function ToolStatus({ tool, intoTurnMs }: { tool: ToolCall; intoTurnMs: number | null }) {
  return (
    <span className="aa-status">
      {tool.status === "running" && <span className="tool-spinner" />}
      {tool.status === "completed" && (
        intoTurnMs != null ? (
          <span className="aa-dur">{formatIntoTurn(intoTurnMs)}</span>
        ) : tool.duration != null ? (
          <span className="aa-dur">{(tool.duration / 1000).toFixed(1)}s</span>
        ) : null
      )}
      {tool.status === "error" && (
        <>
          {intoTurnMs != null && <span className="aa-dur">{formatIntoTurn(intoTurnMs)}</span>}
          {intoTurnMs != null ? " " : null}
          <span className="aa-err">err</span>
        </>
      )}
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
      for (let j = 0; j < msg.toolCalls.length; j++) {
        const tool = msg.toolCalls[j];
        items.push({ tool, msgIndex: i, anchorId: `${msg.id}:${j}:${tool.id}` });
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
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());

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

  useEffect(() => {
    const validIds = new Set(feed.map((item) => item.anchorId));
    setExpandedItems((prev) => {
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [feed]);

  const allExpanded = feed.length > 0 && expandedItems.size === feed.length;

  return (
    <div className="aa-panel">
      <div className="aa-header">
        <div className="aa-header-meta">
          <span className="aa-header-title">activity</span>
        </div>
        <div className="aa-header-actions">
          <button
            className="aa-header-toggle"
            onClick={() => setExpandedItems(allExpanded ? new Set() : new Set(feed.map((item) => item.anchorId)))}
            title={allExpanded ? "Collapse all activity items" : "Expand all activity items"}
          >
            {allExpanded ? "collapse all" : "expand all"}
          </button>
        </div>
      </div>

      {feed.length === 0 ? (
        <div className="aa-empty">
          <svg className="aa-empty-icon" width="20" height="20" viewBox="0 0 12 12" fill="none">
            <path d="M1 6h2l1.5-3 2 6L8.5 3 10 6h1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <span>no activity yet</span>
        </div>
      ) : (
        <div className="aa-feed" ref={scrollRef}>
          {feed.map((item) => {
            const expanded = expandedItems.has(item.anchorId);
            const intoTurnMs = intoTurnMsForTool(messages, item.msgIndex, item.tool);
            const preview = getCard(item.tool.name)({ tool: item.tool, expanded, intoTurnMs });
            const hasDetail = !!preview.detail;
            const toggleControl = (icon: ReactNode) => (
              <button
                className={`aa-icon-toggle${expanded ? " aa-icon-toggle--open" : ""}${hasDetail ? "" : " aa-icon-toggle--static"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!hasDetail) return;
                  setExpandedItems((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.anchorId)) next.delete(item.anchorId);
                    else next.add(item.anchorId);
                    return next;
                  });
                }}
                title={hasDetail ? (expanded ? "Collapse item" : "Expand item") : undefined}
                disabled={!hasDetail}
              >
                {icon}
              </button>
            );
            const rendered = getCard(item.tool.name)({ tool: item.tool, expanded, toggleControl, intoTurnMs });

            return (
              <div
                key={item.anchorId}
                className={`aa-feed-item${item.tool.status === "running" ? " aa-feed-item--active" : ""}`}
              >
                <div
                  className="aa-item-main"
                  onClick={() => scrollChatToTool(item.anchorId, item.tool.id)}
                >
                  {rendered.summary}
                </div>
                {hasDetail && (
                  <div className={`panel-collapse ${expanded ? "panel-collapse--open" : ""}`}>
                    <div className="panel-collapse-clip">
                      {rendered.detail}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
