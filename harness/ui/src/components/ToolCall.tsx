import { useState } from "react";
import type { ToolCall as ToolCallType, Message } from "../types";

type Props = {
  tool: ToolCallType;
};

/** Extract a short human-readable summary from tool input */
function summarize(name: string, input: Record<string, unknown>): string {
  const path = input.file_path as string | undefined;
  const shortPath = path?.replace(/^\/home\/[^/]+\//, "~/") ?? "";

  switch (name) {
    case "Read":
      return shortPath;
    case "Write":
    case "Edit":
    case "MultiEdit":
      return shortPath;
    case "Bash":
      return truncate(input.command as string, 80);
    case "Grep":
      return `/${input.pattern}/${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "Glob":
      return `${input.pattern}${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "WebFetch":
      return truncate(input.url as string, 60);
    case "WebSearch":
      return truncate(input.query as string, 60);
    case "Agent":
      return truncate(input.description as string, 60);
    case "TodoWrite": {
      const todos = input.todos as Array<{ status: string }> | undefined;
      if (!todos?.length) return "";
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

export function ToolCallView({ tool }: Props) {
  const [expanded, setExpanded] = useState(tool.name === "TodoWrite");
  const summary = summarize(tool.name, tool.input);
  const isAgent = tool.name === "Agent" && (tool.subMessages?.length ?? 0) > 0;
  const isTodo = tool.name === "TodoWrite";
  const todos = isTodo ? (tool.input.todos as Array<{ content: string; status: string; activeForm?: string }> | undefined) : undefined;

  return (
    <div className={`tool-call ${tool.status} ${isAgent ? "tool-call--agent" : ""}`}>
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-indicator">
          {tool.status === "running" && <span className="tool-spinner" />}
          {tool.status === "completed" && <span className="tool-dot tool-dot--ok" />}
          {tool.status === "error" && <span className="tool-dot tool-dot--err" />}
        </span>
        <span className="tool-call-name">{tool.name}</span>
        {summary && <span className="tool-call-summary">{summary}</span>}
        {isAgent && (
          <span className="tool-call-sub-count">{countSubTools(tool.subMessages!)} calls</span>
        )}
        {tool.duration != null && (
          <span className="tool-call-duration">{(tool.duration / 1000).toFixed(1)}s</span>
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
}

/** Compact rendering of a sub-agent's message (tool calls + text) */
function SubAgentMessage({ msg }: { msg: Message }) {
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
}
