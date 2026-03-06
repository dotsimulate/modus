import { memo, useState, useEffect } from "react";
import type { ToolCall as ToolCallType, Message, GitCommitDetail } from "../api";
import { fetchGitShow } from "../api";
import { DiffView } from "./DiffView";

type Props = {
  tool: ToolCallType;
  defaultExpanded?: boolean;
  showGitEvents?: boolean;
  cwd?: string | null;
};

/** Extract a short human-readable summary from tool input + result */
function summarize(name: string, input: Record<string, unknown>, result?: string): string {
  const path = input.file_path as string | undefined;
  const shortPath = path?.replace(/^\/home\/[^/]+\//, "~/") ?? "";

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
    case "Write":
    case "write":
    case "Edit":
    case "edit":
    case "MultiEdit":
      return shortPath || truncate(input.path as string, 80);
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

/** Detect git event type from a Bash tool call */
type GitEventType = "commit" | "push" | null;
function detectGitEvent(tool: ToolCallType): GitEventType {
  if (tool.name !== "Bash") return null;
  const cmd = tool.input.command as string ?? "";
  if (/git\s+push/.test(cmd)) return "push";
  if (/git\s+(commit|merge)/.test(cmd)) return "commit";
  return null;
}

/** Parse commit hash from git commit output — matches [branch hash] pattern */
const COMMIT_HASH_RE = /\[[\w/.-]+\s+([0-9a-f]{7,})\]/;
function parseCommitHash(result: string): string | null {
  const m = result.match(COMMIT_HASH_RE);
  return m ? m[1] : null;
}

/** Parse commit message from git output — text after [branch hash] on same line */
const COMMIT_MSG_RE = /\[[\w/.-]+\s+[0-9a-f]+\]\s+(.+)/;
function parseCommitMessage(result: string): string {
  const m = result.match(COMMIT_MSG_RE);
  return m ? m[1] : "";
}

/** Parse push summary from git push output */
function parsePushSummary(result: string): string {
  // e.g. "To github.com:user/repo.git\n   abc1234..def5678  main -> main"
  const branchMatch = result.match(/(\S+)\s*->\s*(\S+)/);
  const repoMatch = result.match(/To\s+(\S+)/);
  const parts: string[] = [];
  if (repoMatch) parts.push(repoMatch[1].replace(/\.git$/, "").replace(/^.*[:/]/, ""));
  if (branchMatch) parts.push(branchMatch[2]);
  return parts.join(" ");
}

/** Inline git commit card — subagent-style with left gutter chevron */
function GitCommitInline({ hash, message, result, cwd, expanded, onToggle }: {
  hash: string;
  message: string;
  result: string;
  cwd: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!expanded || detail) return;
    let active = true;
    setLoading(true);
    fetchGitShow(cwd, hash)
      .then((d) => { if (active) setDetail(d); })
      .catch(() => {})
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expanded, hash, cwd]);

  // Parse file stats from git output
  const statsMatch = result.match(/(\d+)\s+files?\s+changed(?:,\s+(\d+)\s+insertion[^,]*)?(?:,\s+(\d+)\s+deletion.*)?/);
  const filesChanged = statsMatch ? parseInt(statsMatch[1]) : null;
  const additions = statsMatch?.[2] ? parseInt(statsMatch[2]) : null;
  const deletions = statsMatch?.[3] ? parseInt(statsMatch[3]) : null;

  return (
    <div className="git-inline">
      <div className="git-inline-gutter">
        <svg width="8" height="8" viewBox="0 0 8 8">
          {expanded
            ? <path d="M1.5 5L4 2.5L6.5 5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round"/>
            : <path d="M2.5 1.5L5 4L2.5 6.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinecap="round"/>
          }
        </svg>
      </div>
      <div className="git-inline-content">
        <div className="git-inline-summary" onClick={onToggle}>
          <span className="git-inline-msg">{message}</span>
          <span className="git-inline-meta">
            <span className="git-inline-hash">{hash.slice(0, 7)}</span>
            {filesChanged != null && (
              <span className="git-inline-files">{filesChanged} file{filesChanged !== 1 ? "s" : ""}</span>
            )}
            {additions != null && additions > 0 && (
              <span className="diff-stat diff-stat--add">+{additions}</span>
            )}
            {deletions != null && deletions > 0 && (
              <span className="diff-stat diff-stat--del">-{deletions}</span>
            )}
          </span>
        </div>
        {expanded && (
          <div className="git-inline-diff">
            {loading && <div className="git-empty">Loading diff...</div>}
            {detail && <DiffView files={detail.files} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Inline git push card */
function GitPushInline({ result }: { result: string }) {
  const summary = parsePushSummary(result);
  return (
    <div className="git-inline">
      <div className="git-inline-gutter" />
      <div className="git-inline-content">
        <div className="git-inline-summary">
          <span className="git-inline-msg">{summary || "pushed"}</span>
        </div>
      </div>
    </div>
  );
}

export const ToolCallView = memo(function ToolCallView({ tool, defaultExpanded, showGitEvents = true, cwd }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? tool.name === "TodoWrite");
  const isTodo = tool.name === "TodoWrite";

  // Auto-collapse old TodoWrites when a newer one arrives
  useEffect(() => {
    if (isTodo && defaultExpanded === false) setExpanded(false);
  }, [defaultExpanded]);

  // Git event detection
  const gitEvent = showGitEvents && tool.status === "completed" && tool.result ? detectGitEvent(tool) : null;
  const commitHash = gitEvent === "commit" ? parseCommitHash(tool.result!) : null;

  // Render as inline git commit card (blue)
  if (gitEvent === "commit" && commitHash && cwd) {
    const commitMsg = parseCommitMessage(tool.result!);
    return (
      <div className={`tool-call tool-call--git-commit completed${expanded ? " tool-call--git-expanded" : ""}`}>
        <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
          <span className="tool-call-indicator">
            <span className="tool-dot tool-dot--commit" />
          </span>
          <span className="tool-call-name">commit</span>
          {tool.duration != null && (
            <span className="tool-call-duration">{(tool.duration / 1000).toFixed(1)}s</span>
          )}
        </div>
        <GitCommitInline hash={commitHash} message={commitMsg} result={tool.result!} cwd={cwd} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      </div>
    );
  }

  // Render as inline git push card (green)
  if (gitEvent === "push") {
    return (
      <div className="tool-call tool-call--git-push completed">
        <div className="tool-call-header">
          <span className="tool-call-indicator">
            <span className="tool-dot tool-dot--push" />
          </span>
          <span className="tool-call-name">push</span>
          {tool.duration != null && (
            <span className="tool-call-duration">{(tool.duration / 1000).toFixed(1)}s</span>
          )}
        </div>
        <GitPushInline result={tool.result!} />
      </div>
    );
  }

  const summary = summarize(tool.name, tool.input, tool.result);
  const isAgent = tool.name === "Agent" && (tool.subMessages?.length ?? 0) > 0;
  const isRead = tool.name === "Read" || tool.name === "read";
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
