import { memo, useState, useEffect, useCallback } from "react";
import type { ToolCall as ToolCallType, Message } from "../../../sdk/index";
import { EditHunk } from "./FileChanges";

type Props = {
  tool: ToolCallType;
  defaultExpanded?: boolean;
  anchorId?: string;
  showGitEvents?: boolean;
  cwd?: string | null;
  onStopTask?: (taskId: string) => void;
};

function displayToolName(name: string): string {
  if (name === "CommandExecution") return "command execution";
  if (name === "FileChange") return "file change";
  if (name === "WebSearch") return "web search";
  if (name === "MCPToolCall") return "mcp tool call";
  return name;
}

/** Extract a short human-readable summary from tool input + result */
function summarize(name: string, input: Record<string, unknown>): string {
  const path = input.file_path as string | undefined;
  const shortPath = path?.replace(/^\/home\/[^/]+\//, "~/") ?? "";
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  }

  switch (name) {
    case "Read":
    case "read": {
      const p = shortPath || truncate(input.path as string, 80);
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset && limit) return `${p} :${offset}-${offset + limit}`;
      if (offset) return `${p} :${offset}`;
      if (limit) return `${p} (${limit} lines)`;
      return p;
    }
    case "FileChange": {
      const kind = input.change_kind as string | undefined;
      const file = shortPath || truncate(input.path as string, 80) || truncate(input.file_path as string, 80);
      return kind ? `${kind} ${file}` : file;
    }
    case "Write":
    case "write":
    case "Edit":
    case "edit":
    case "MultiEdit":
      return shortPath || truncate(input.path as string, 80);
    case "CommandExecution":
    case "Bash":
    case "bash":
      return truncate(input.command as string, 80);
    case "Grep":
    case "grep":
      return `/${input.pattern}/${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "Glob":
      return `${input.pattern}${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "find":
      return truncate(input.pattern as string ?? input.path as string, 80);
    case "ls":
      return truncate(input.path as string, 80);
    case "WebFetch":
      return truncate(input.url as string, 60);
    case "WebSearch":
      return truncate(input.query as string, 60);
    case "MCPToolCall": {
      const server = input.server as string | undefined;
      const tool = input.tool as string | undefined;
      if (server && tool) return `${server}/${tool}`;
      return server || tool || "";
    }
    case "Agent":
      return truncate(input.description as string, 60);
    case "TodoWrite": {
      const todos = input.todos;
      if (!Array.isArray(todos) || !todos.length) return "";
      const done = todos.filter(t => t.status === "completed").length;
      const active = todos.filter(t => t.status === "in_progress").length;
      const pending = todos.filter(t => t.status === "pending").length;
      const parts: string[] = [];
      if (done) parts.push(`${done} done`);
      if (active) parts.push(`${active} active`);
      if (pending) parts.push(`${pending} pending`);
      return parts.join(" · ");
    }
    case "Skill":
      return input.skill as string ?? "";
    default:
      return "";
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

/** Does a string look like code or multiline content? */
function isCodeLike(s: string): boolean {
  if (s.includes("\n")) return true;
  if (s.length > 120) return true;
  // Common code patterns
  if (/[{}();]/.test(s) && s.length > 40) return true;
  return false;
}

/** Shorten paths for display */
function shortPath(s: string): string {
  return s.replace(/^\/home\/[^/]+\//, "~/");
}

/** Unwrap JSON-stringified text (PI results can be double-encoded) */
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
      // Handle {"content":[{"type":"text","text":"..."}]} format
      if (parsed && Array.isArray(parsed.content)) {
        return parsed.content
          .map((b: any) => (typeof b === "string" ? b : b.text ?? JSON.stringify(b)))
          .join("\n");
      }
    } catch { /* not JSON, use as-is */ }
  }
  return s;
}

/** Render file content with line numbers, diff-table style */
function ReadOutput({ result, offset }: { result: string; offset?: number }) {
  const text = unwrapResult(result);
  const lines = text.split("\n");
  // Drop trailing empty line from split
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const startLine = (offset ?? 1);

  return (
    <div className="tool-output-box read-output">
      <table className="diff-table">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i} className="diff-line diff-line--ctx">
              <td className="diff-gutter">{startLine + i}</td>
              <td className="diff-code"><span>{line}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render tool input as formatted key-value pairs.
 *  Skip if there's only one simple string arg (already shown in header summary). */
function ToolInputArgs({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input).filter(([, v]) => v != null && v !== "");
  if (entries.length === 0) return null;

  // If only one entry and it's a short string, the header already shows it
  if (entries.length === 1) {
    const [, val] = entries[0];
    if (typeof val === "string" && !isCodeLike(val)) return null;
  }

  return (
    <div className="tool-args">
      {entries.map(([key, val]) => {
        const str = typeof val === "string" ? val : JSON.stringify(val, null, 2);
        const display = typeof val === "string" && (key.includes("path") || key === "file_path")
          ? shortPath(str) : str;
        const multiline = isCodeLike(display);

        return (
          <div key={key} className={`tool-arg ${multiline ? "tool-arg--block" : ""}`}>
            <span className="tool-arg-key">{key}</span>
            {multiline ? (
              <pre className="tool-arg-code">{display}</pre>
            ) : (
              <span className="tool-arg-val">{display}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Render TodoWrite as a compact checklist */
function TodoList({ todos }: { todos: Array<{ content: string; status: string; activeForm?: string }> }) {
  if (!Array.isArray(todos)) return null;
  return (
    <div className="todo-list">
      {todos.map((t, i) => (
        <div key={i} className={`todo-item todo-item--${t.status}`}>
          <span className="todo-indicator">
            {t.status === "completed" && <span className="tool-dot tool-dot--ok" />}
            {t.status === "in_progress" && <span className="tool-spinner" />}
            {t.status === "pending" && <span className="tool-dot todo-dot--pending" />}
          </span>
          <span className="todo-text">
            {t.status === "in_progress" ? (t.activeForm || t.content) : t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Count total tool calls across sub-messages */
function countSubTools(msgs: Message[]): number {
  return msgs.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0);
}

/** Render Edit/Write/MultiEdit as inline diff */
function EditDiffDetail({ tool }: { tool: ToolCallType }) {
  const name = tool.name;
  const inp = tool.input;

  type FileEdit = {
    filePath: string;
    type: "edit" | "write";
    oldString?: string;
    newString?: string;
    content?: string;
  };

  const edits: FileEdit[] = [];
  const fp = (inp.file_path as string) ?? "";

  if (name === "Write" || name === "write") {
    edits.push({ filePath: fp, type: "write", content: inp.content as string ?? "" });
  } else if (name === "MultiEdit" && Array.isArray(inp.edits)) {
    for (const e of inp.edits as Array<{ old_string?: string; new_string?: string }>) {
      edits.push({ filePath: fp, type: "edit", oldString: e.old_string ?? "", newString: e.new_string ?? "" });
    }
  } else {
    edits.push({ filePath: fp, type: "edit", oldString: inp.old_string as string ?? "", newString: inp.new_string as string ?? "" });
  }

  return (
    <div className="tool-call-detail tool-call-detail--edit">
      <table className="diff-table">
        {edits.map((edit, i) => (
          <EditHunk key={i} edit={edit} idx={i} />
        ))}
      </table>
    </div>
  );
}

export const ToolCallView = memo(function ToolCallView({ tool, defaultExpanded, anchorId, onStopTask }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? (tool.name === "TodoWrite"));
  const isTodo = tool.name === "TodoWrite";

  const canCancel = tool.status === "running" && tool.taskId && onStopTask;
  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (tool.taskId && onStopTask) onStopTask(tool.taskId);
  }, [tool.taskId, onStopTask]);

  // Auto-collapse old TodoWrites when a newer one arrives
  useEffect(() => {
    if (isTodo && defaultExpanded === false) setExpanded(false);
  }, [defaultExpanded]);

  const summary = summarize(tool.name, tool.input);
  const isAgent = tool.name === "Agent" && (tool.subMessages?.length ?? 0) > 0;
  const isRead = tool.name === "Read" || tool.name === "read";
  const isEdit = /^(Edit|edit|MultiEdit|Write|write|FileChange)$/.test(tool.name);
  const todos = isTodo ? (tool.input.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined) : undefined;

  return (
    <div
      className={`tool-call ${tool.status} ${isAgent ? "tool-call--agent" : ""}`}
      data-tool-id={tool.id}
      data-tool-anchor={anchorId}
    >
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-indicator">
          {tool.status === "running" && <span className="tool-spinner" />}
          {tool.status === "completed" && <span className="tool-dot tool-dot--ok" />}
          {tool.status === "error" && <span className="tool-dot tool-dot--err" />}
        </span>
        <span className="tool-call-name">{displayToolName(tool.name)}</span>
        {summary && <span className="tool-call-summary">{summary}</span>}
        {isAgent && (
          <span className="tool-call-sub-count">{countSubTools(tool.subMessages!)} calls</span>
        )}
        {tool.duration != null && (
          <span className="tool-call-duration">{(tool.duration / 1000).toFixed(1)}s</span>
        )}
        {canCancel && (
          <button className="tool-call-cancel" onClick={handleCancel} title="Cancel this task">
            <svg width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        )}
        <span className="tool-call-expand">{expanded ? "−" : "+"}</span>
      </div>

      <div className={`panel-collapse ${expanded ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          {isAgent ? (
            <div className="subagent-detail">
              <div className="subagent-gutter" onClick={() => setExpanded(false)} title="collapse">
                <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1.5 5L4 2.5L6.5 5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round"/></svg>
              </div>
              <div className="subagent-content">
                {tool.subMessages!.map((msg, i) => (
                  <SubAgentMessage key={i} msg={msg} />
                ))}
                {tool.subSummary && (
                  <div className="subagent-summary">{tool.subSummary}</div>
                )}
              </div>
            </div>
          ) : isTodo && todos?.length ? (
            <div className="tool-call-detail">
              <TodoList todos={todos} />
            </div>
          ) : isEdit ? (
            <EditDiffDetail tool={tool} />
          ) : isRead && tool.result ? (
            <div className="tool-call-detail tool-call-detail--read">
              <ReadOutput result={tool.result} offset={tool.input.offset as number | undefined} />
            </div>
          ) : (
            <div className="tool-call-detail">
              <ToolInputArgs input={tool.input} />
              <div className="tool-output-box">
                <div className="tool-output-label">output</div>
                <pre className={`tool-output-content${tool.result == null && tool.status === "running" ? " tool-output--pending" : ""}`}>
                  {tool.result ?? (tool.status === "running" ? "..." : "—")}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

/** Compact rendering of a sub-agent's message (tool calls + text) */
const SubAgentMessage = memo(function SubAgentMessage({ msg }: { msg: Message }) {
  return (
    <div className="subagent-msg">
      {msg.toolCalls && msg.toolCalls.length > 0 && (
        <div className="subagent-tools">
          {msg.toolCalls.map((tc) => (
            <ToolCallView key={tc.id} tool={tc} />
          ))}
        </div>
      )}
      {msg.content && (
        <div className="subagent-text">{msg.content}</div>
      )}
    </div>
  );
});
