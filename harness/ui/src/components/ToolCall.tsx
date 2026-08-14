import { Component, memo, useState, useEffect, useCallback, type ComponentType, type ReactNode } from "react";
import type { ToolCall as ToolCallType, Message, SessionArtifact } from "../../../sdk/index";
import { EditHunk } from "./FileChanges";
import { useFileViewer } from "../providers/FileViewerContext";
import { AttachmentImage } from "./AttachmentImage";
import { ImageLightbox } from "./ImageLightbox";
import { modus, tokenParam } from "../modusClient";
import { backendUrl } from "../backendTarget";
import { onUiEvent } from "../sessionStore";
import { parseMoveApiResultText } from "../../../move-api-result";
import {
  moveApiInput,
  moveApiOp,
  moveApiToken,
  moveToolViewCssUrl,
  moveToolViewModuleUrl,
  resolveMoveToolView,
  type MoveApiClientResult,
  type MoveToolViewProps,
  type MoveToolViewResolution,
} from "../move-tool-view";
import {
  evictMoveComponent,
  getCachedMoveComponent,
  loadMoveComponent,
  loadMoveComponentCSS,
} from "./move-component-loader";

type Props = {
  tool: ToolCallType;
  defaultExpanded?: boolean;
  anchorId?: string;
  showGitEvents?: boolean;
  cwd?: string | null;
  onStopTask?: (taskId: string) => void;
  sessionId?: string | null;
  latestMoveToolCallIds?: ReadonlyMap<string, string>;
  artifacts?: SessionArtifact[];
};

class MoveToolViewErrorBoundary extends Component<{
  fallback: ReactNode;
  resetKey: string;
  children: ReactNode;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function displayToolName(name: string): string {
  if (name === "CommandExecution") return "command execution";
  if (name === "FileChange") return "file change";
  if (name === "WebSearch") return "web search";
  if (name === "MCPToolCall") return "mcp tool call";
  return name;
}

/**
 * Fold the many spellings of one tool onto a single key.
 *
 * Providers disagree about casing for the same tool (`Read`/`read`,
 * `Bash`/`bash`) and about separators (`web_search` vs `WebSearch`), which is
 * why this switch used to carry a case per spelling.
 */
function canonicalToolName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

/** Arguments worth putting in a headline, most specific first. */
const SUMMARY_KEYS = [
  "file_path", "filePath", "path", "notebook_path",
  "command", "cmd", "script",
  "pattern", "query", "url", "prompt", "description", "skill", "name",
];

const PATH_KEYS = new Set(["file_path", "filePath", "path", "notebook_path"]);

/**
 * Headline for a tool this build has no specific shape for.
 *
 * An enumerated switch structurally cannot cover every tool: antigravity and
 * gemini-cli pass their provider's own tool names straight through, and cursor
 * derives names from its wire keys, so the set is open-ended. Reading the input
 * instead of the name means a new or third-party tool still says something.
 */
function genericSummary(input: Record<string, unknown>): string {
  for (const key of SUMMARY_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(PATH_KEYS.has(key) ? shortPath(value) : value, 80);
    }
    // Some providers pass a command as argv rather than a string.
    if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
      return truncate(value.join(" "), 80);
    }
  }
  // Nothing recognised. The first short scalar still beats a bare tool name.
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.trim() && value.length <= 120) {
      return `${key}: ${truncate(value, 60)}`;
    }
  }
  return "";
}

/** Extract a short human-readable summary from tool input + result */
export function summarize(name: string, input: Record<string, unknown>): string {
  const filePath = shortPath((input.file_path as string | undefined) ?? "");
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    if (parts.length >= 3) return `${parts[1]}/${parts[2]}`;
  }

  switch (canonicalToolName(name)) {
    case "read": {
      const p = filePath || truncate(shortPath(input.path as string ?? ""), 80);
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset && limit) return `${p} :${offset}-${offset + limit}`;
      if (offset) return `${p} :${offset}`;
      if (limit) return `${p} (${limit} lines)`;
      return p;
    }
    case "filechange": {
      const kind = input.change_kind as string | undefined;
      const file = filePath || truncate(shortPath(input.path as string ?? ""), 80);
      return kind ? `${kind} ${file}` : file;
    }
    case "write":
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "applypatch":
      return filePath || truncate(shortPath(input.path as string ?? ""), 80);
    case "commandexecution":
    case "bash":
    case "powershell":
    case "shell":
    case "exec": {
      const command = input.command;
      if (Array.isArray(command)) return truncate(command.join(" "), 80);
      return truncate(command as string, 80);
    }
    case "grep":
      return `/${input.pattern}/${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "glob":
      return `${input.pattern}${input.path ? ` in ${basename(input.path as string)}` : ""}`;
    case "find":
      return truncate(input.pattern as string ?? input.path as string, 80);
    case "ls":
      return truncate(shortPath(input.path as string ?? ""), 80);
    case "webfetch":
      return truncate(input.url as string, 60);
    case "websearch":
      return truncate(input.query as string, 60);
    case "mcptoolcall": {
      const server = input.server as string | undefined;
      const tool = input.tool as string | undefined;
      if (server && tool) return `${server}/${tool}`;
      return server || tool || "";
    }
    case "agent":
    case "task":
    case "workflow":
      return truncate(input.description as string ?? input.prompt as string, 60);
    case "todowrite":
    case "updateplan": {
      const todos = input.todos ?? input.plan;
      if (!Array.isArray(todos) || !todos.length) return "";
      const done = todos.filter(t => t?.status === "completed").length;
      const active = todos.filter(t => t?.status === "in_progress").length;
      const pending = todos.filter(t => t?.status === "pending").length;
      const parts: string[] = [];
      if (done) parts.push(`${done} done`);
      if (active) parts.push(`${active} active`);
      if (pending) parts.push(`${pending} pending`);
      return parts.join(" · ");
    }
    case "skill":
      return input.skill as string ?? "";
    case "askuserquestion":
      return truncate((input.questions as { question?: string }[] | undefined)?.[0]?.question, 60);
    case "toolsearch":
      return truncate(input.query as string, 60);
    default:
      return genericSummary(input);
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

function readRange(input: Record<string, unknown>): { line?: number; endLine?: number } {
  const line =
    typeof input.offset === "number" ? input.offset
    : typeof input.line === "number" ? input.line
    : typeof input.start_line === "number" ? input.start_line
    : undefined;
  const endLine =
    typeof input.endLine === "number" ? input.endLine
    : typeof input.end_line === "number" ? input.end_line
    : line !== undefined && typeof input.limit === "number" ? line + Math.max(0, input.limit - 1)
    : undefined;
  return { line, endLine };
}

/** Does a string look like code or multiline content? */
function isCodeLike(s: string): boolean {
  if (s.includes("\n")) return true;
  if (s.length > 120) return true;
  // Common code patterns
  if (/[{}();]/.test(s) && s.length > 40) return true;
  return false;
}

/**
 * Shorten a home-directory prefix for display, on any platform.
 *
 * This matched `/home/<user>/` only, so it silently did nothing on macOS and
 * Windows — two of the three platforms Modus ships to.
 */
export function shortPath(s: string): string {
  return s
    .replace(/^\/(?:home|Users)\/[^/]+\//, "~/")
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+[\\/]/, "~/");
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
/** How much tool output to paint before offering to expand. */
const OUTPUT_PREVIEW_CHARS = 2000;

/**
 * Images a tool returned, rendered as pictures.
 *
 * These used to arrive base64-encoded inside the result text and be cut off
 * partway through, so a returned screenshot read as a wall of characters.
 */
function ToolResultImages({ tool }: { tool: ToolCallType }) {
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  if (!tool.images || tool.images.length === 0) return null;

  return (
    <div className="tool-output-images">
      {tool.images.map((image, i) => (
        <AttachmentImage
          key={i}
          mediaType={image.mediaType}
          data={image.data}
          alt={image.name ?? `${tool.name} image ${i + 1}`}
          onOpen={(src, alt) => setLightbox({ src, alt })}
        />
      ))}
      {lightbox && (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      )}
    </div>
  );
}

/**
 * Tool output text, truncated for render but never silently.
 *
 * Painting an arbitrarily long `<pre>` is the reason a cap exists at all, so
 * long output stays collapsed by default — but the cut is always labelled with
 * the real size and can be expanded. Previously the text was cut at 2000
 * characters before it ever reached this component and simply ended.
 */
function ToolOutputText({ tool }: { tool: ToolCallType }) {
  const [expanded, setExpanded] = useState(false);

  if (tool.result == null) {
    return (
      <pre className={`tool-output-content${tool.status === "running" ? " tool-output--pending" : ""}`}>
        {tool.status === "running" ? "..." : "—"}
      </pre>
    );
  }

  const stored = tool.result;
  // Anything beyond what the client kept is gone for good; say so rather than
  // implying the expanded view is complete.
  const droppedAtStore = tool.resultFullLength != null;
  const clipped = !expanded && stored.length > OUTPUT_PREVIEW_CHARS;
  const shown = clipped ? stored.slice(0, OUTPUT_PREVIEW_CHARS) : stored;

  return (
    <>
      <pre className="tool-output-content">{shown}</pre>
      {(clipped || droppedAtStore) && (
        <div className="tool-output-truncation">
          {clipped && (
            <button
              type="button"
              className="tool-output-expand"
              onClick={() => setExpanded(true)}
            >
              show all {stored.length.toLocaleString()} characters
            </button>
          )}
          {!clipped && stored.length > OUTPUT_PREVIEW_CHARS && (
            <button
              type="button"
              className="tool-output-expand"
              onClick={() => setExpanded(false)}
            >
              collapse
            </button>
          )}
          {droppedAtStore && (
            <span className="tool-output-dropped">
              output was {tool.resultFullLength!.toLocaleString()} characters; the rest was not kept
            </span>
          )}
        </div>
      )}
    </>
  );
}

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

export const ToolCallView = memo(function ToolCallView({
  tool,
  defaultExpanded,
  anchorId,
  onStopTask,
  sessionId,
  latestMoveToolCallIds,
  artifacts,
}: Props) {
  const { openFile } = useFileViewer();
  const [expanded, setExpanded] = useState(defaultExpanded ?? (tool.name === "TodoWrite"));
  const [toolViewResolution, setToolViewResolution] = useState<MoveToolViewResolution | null>(null);
  const [ToolViewComponent, setToolViewComponent] = useState<ComponentType<MoveToolViewProps> | null>(null);
  // A claimed row that falls back to the native rendering is indistinguishable
  // from an unclaimed one, and a packaged desktop has no console to check. Keep
  // the reason so the row can say why instead of silently degrading.
  const [toolViewError, setToolViewError] = useState<string | null>(null);
  const isTodo = tool.name === "TodoWrite";
  const apiToken = moveApiToken(tool);
  const op = moveApiOp(tool);

  // Depend on the presence of transcript context, not the map identity —
  // `latestMoveToolCallIds` is rebuilt on every message change, so using it as a
  // dependency re-ran this effect on each stream delta for no gain.
  const hasTranscriptContext = !!sessionId && !!latestMoveToolCallIds;

  useEffect(() => {
    let active = true;
    if (!apiToken || !hasTranscriptContext) {
      setToolViewResolution(null);
      setToolViewError(null);
      return () => { active = false; };
    }
    setToolViewError(null);
    void resolveMoveToolView(apiToken).then((result) => {
      if (!active) return;
      setToolViewResolution(result.resolution);
      setToolViewError(result.error);
    });
    return () => { active = false; };
  }, [apiToken, hasTranscriptContext]);

  const opIsClaimed = !!toolViewResolution
    && !!op
    && (!toolViewResolution.toolView.ops || toolViewResolution.toolView.ops.includes(op));
  const toolViewModuleUrl = opIsClaimed && toolViewResolution
    ? moveToolViewModuleUrl(toolViewResolution)
    : null;

  useEffect(() => {
    let active = true;
    if (!toolViewModuleUrl || !toolViewResolution) {
      setToolViewComponent(null);
      return () => { active = false; };
    }

    if (toolViewResolution.toolView.cache === "none") {
      evictMoveComponent(toolViewModuleUrl);
    }
    const cached = getCachedMoveComponent<MoveToolViewProps>(toolViewModuleUrl);
    if (cached) {
      setToolViewComponent(() => cached);
      return () => { active = false; };
    }

    setToolViewComponent(null);
    setToolViewError(null);
    void loadMoveComponentCSS(moveToolViewCssUrl(toolViewResolution), toolViewResolution.moveName);
    void loadMoveComponent<MoveToolViewProps>(toolViewModuleUrl, toolViewResolution.moveName)
      .then((component) => {
        if (active) setToolViewComponent(() => component);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setToolViewComponent(null);
        setToolViewError(reason instanceof Error ? reason.message : "component failed to load");
      });
    return () => { active = false; };
  }, [toolViewModuleUrl, toolViewResolution]);

  const callOp = useCallback(async (
    nextOp: string,
    data?: Record<string, unknown>,
  ): Promise<MoveApiClientResult> => {
    if (!toolViewResolution || !apiToken) throw new Error("Move tool view is not connected");
    return modus.callMoveOp(toolViewResolution.moveName, apiToken, nextOp, data);
  }, [apiToken, toolViewResolution]);

  const submitMessage = useCallback(async (prompt: string) => {
    if (!sessionId) throw new Error("Move tool view has no session");
    await modus.sendMessage(sessionId, prompt);
  }, [sessionId]);

  const subscribe = useCallback((listener: (event: { type: string; payload?: Record<string, unknown> }) => void) => {
    if (!sessionId || !apiToken || !toolViewResolution) return () => {};
    return onUiEvent("move-widget-event", (eventSessionId, event) => {
      if (eventSessionId !== sessionId) return;
      if (event.instanceId !== toolViewResolution.instanceId) return;
      if (event.apiToken !== apiToken) return;
      if (!event.event || typeof event.event.type !== "string") return;
      listener(event.event as { type: string; payload?: Record<string, unknown> });
    });
  }, [apiToken, sessionId, toolViewResolution]);

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
  const readPath = isRead ? ((tool.input.file_path as string | undefined) ?? (tool.input.path as string | undefined)) : undefined;
  const readLines = readRange(tool.input);
  // Only a claimed row consumes this. Parsing unconditionally ran a scan over
  // every Read/Bash/Edit result in the transcript on every render, and the
  // transcript re-renders per stream delta.
  const parsedResult = ToolViewComponent && tool.result !== undefined
    ? parseMoveApiResultText(tool.result, tool.status !== "error")
    : undefined;
  const resolvedArtifacts = artifacts?.map((artifact) => {
    const url = backendUrl(artifact.url);
    const token = tokenParam();
    return {
      ...artifact,
      url: token ? `${url}${url.includes("?") ? "&" : "?"}${token}` : url,
    };
  });
  const authoredView = ToolViewComponent && toolViewResolution && apiToken && op && sessionId && latestMoveToolCallIds
    ? (
        <ToolViewComponent
          moveName={toolViewResolution.moveName}
          instanceId={toolViewResolution.instanceId}
          apiToken={apiToken}
          sessionId={sessionId}
          op={op}
          input={moveApiInput(tool)}
          result={parsedResult}
          resultState={tool.result === undefined ? "pending" : "ready"}
          artifacts={resolvedArtifacts}
          status={tool.status}
          isLatest={latestMoveToolCallIds.get(apiToken) === tool.id}
          expanded={expanded}
          setExpanded={setExpanded}
          callOp={callOp}
          submitMessage={submitMessage}
          subscribe={subscribe}
        />
      )
    : null;

  const defaultDetail = isAgent ? (
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
      <ToolResultImages tool={tool} />
      <div className="tool-output-box">
        <div className="tool-output-label">output</div>
        <ToolOutputText tool={tool} />
      </div>
    </div>
  );

  const renderRow = (detail: ReactNode) => (
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
        {readPath && (
          <button
            className="tool-call-cancel"
            onClick={(e) => {
              e.stopPropagation();
              openFile(readPath, {
                line: readLines.line,
                endLine: readLines.endLine,
                highlight: readLines.line !== undefined,
                source: "tool-read",
              });
            }}
            title={readLines.line ? "Open file at read lines" : "Open file"}
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 6s1.8-3 5-3 5 3 5 3-1.8 3-5 3-5-3-5-3Z" stroke="currentColor" strokeWidth="1.1"/>
              <circle cx="6" cy="6" r="1.5" stroke="currentColor" strokeWidth="1.1"/>
            </svg>
          </button>
        )}
        <span className="tool-call-expand">{expanded ? "−" : "+"}</span>
      </div>

      <div className={`panel-collapse ${expanded ? "panel-collapse--open" : ""}`}>
        <div className="panel-collapse-clip">
          {detail}
        </div>
      </div>
    </div>
  );

  const defaultRow = renderRow(defaultDetail);
  if (!authoredView || !toolViewResolution) {
    if (!toolViewError) return defaultRow;
    return (
      <>
        {defaultRow}
        <div
          className="tool-call-note"
          style={{ padding: "4px 9px 6px", color: "var(--text-dim)", fontSize: 11 }}
        >
          tool view unavailable — {toolViewError}
        </div>
      </>
    );
  }

  const resetKey = `${apiToken}:${op}:${toolViewModuleUrl}`;
  if ((toolViewResolution.toolView.takeover ?? "block") === "body") {
    return renderRow(
      <MoveToolViewErrorBoundary fallback={defaultDetail} resetKey={resetKey}>
        {authoredView}
      </MoveToolViewErrorBoundary>,
    );
  }

  return (
    <MoveToolViewErrorBoundary fallback={defaultRow} resetKey={resetKey}>
      <div
        className={`move-tool-view move-tool-view--block ${tool.status}`}
        data-tool-id={tool.id}
        data-tool-anchor={anchorId}
      >
        {authoredView}
      </div>
    </MoveToolViewErrorBoundary>
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
