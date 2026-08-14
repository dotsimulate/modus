import type { Message, MoveToolViewInfo, SessionArtifact, ToolCall } from "../../sdk/index";
import { backendUrl } from "./backendTarget";
import { authHeaders } from "./modusClient";

export type MoveToolViewResolution = {
  moveName: string;
  cwd: string;
  instanceId: string;
  sessionId: string;
  toolView: MoveToolViewInfo;
};

export type MoveToolViewResolutionResult =
  | { resolution: MoveToolViewResolution; error: null }
  | { resolution: null; error: string };

export type MoveApiClientResult = {
  ok: boolean;
  message?: string;
  error?: string;
} & Record<string, unknown>;

/** Props passed to a move's declared tool-view component. */
export type MoveToolViewProps = {
  moveName: string;
  instanceId: string;
  apiToken: string;
  sessionId: string;
  op: string;
  input: Record<string, unknown>;
  result?: MoveApiClientResult;
  /**
   * Whether `result` is trustworthy yet.
   *
   * `result` being undefined is ambiguous on its own — the call may still be
   * running, or the turn's details may have been deferred for transport and not
   * loaded back. Views that guessed rendered a hard error for what was really a
   * loading state. The substrate knows the difference, so it says which.
   *
   * The op arguments are in `input`, which is part of the tool call itself and
   * survives every transport; prefer it over `result` for anything needed to
   * paint before the call completes.
   */
  resultState: "pending" | "ready";
  /** Reserved for the immutable per-call record contract planned for v2. */
  record?: unknown;
  artifacts?: SessionArtifact[];
  status: ToolCall["status"];
  isLatest: boolean;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  callOp: (op: string, data?: Record<string, unknown>) => Promise<MoveApiClientResult>;
  submitMessage: (prompt: string) => Promise<void>;
  subscribe?: (listener: (event: { type: string; payload?: Record<string, unknown> }) => void) => () => void;
};

export type ToolRunPartition = {
  moveApi: boolean;
  tools: ToolCall[];
};

/**
 * How long a failed lookup stays cached.
 *
 * A negative result is not durable knowledge: the backend restarts under the
 * desktop shell, and a transcript can paint before it is reachable. Caching
 * `null` forever would silently downgrade every block for that token to the
 * native row until a full page reload. Retrying is cheap; the window only
 * exists so a genuinely deleted move does not refetch on every mount.
 */
const NEGATIVE_RESOLUTION_TTL_MS = 15_000;

const resolutionCache = new Map<string, Promise<MoveToolViewResolutionResult>>();
const negativeResolvedAt = new Map<string, number>();

/**
 * Grok Build (and similar meta-MCP hosts) do not call `modus_submit` directly.
 * They emit `use_tool` with `{ tool_name: "modus__modus_submit", tool_input }`.
 * The transcript stores that raw shape, so claim logic has to unwrap it or
 * every move tool-view silently degrades to a native tool row.
 */
export function moveApiSourceInput(tool: ToolCall): Record<string, unknown> {
  const input = tool.input;
  const name = tool.name;
  if (name === "use_tool" || name === "UseTool") {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (toolName.includes("modus_submit")) {
      const nested = input.tool_input;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return input;
}

export function moveApiToken(tool: ToolCall): string | null {
  const token = moveApiSourceInput(tool).token;
  return typeof token === "string" && token.startsWith("mapi-") ? token : null;
}

/**
 * Normalize the three shapes `modus_submit` accepts into the payload the
 * handler actually received.
 *
 * `modus-mcp.ts` declares `data` as a plain string and widens it server-side:
 * an object from native MCP clients, a JSON *string* from Claude Code's XML
 * serialization, or absent with the fields passed flat by smaller models. The
 * transcript sees the raw tool input, so it has to widen it the same way — a
 * client that only understood the object shape silently failed to identify the
 * op for every Claude Code call, which is the common case.
 *
 * Cached per input object: this runs on every render of every tool row, and
 * the transcript re-renders per stream delta.
 */
const payloadCache = new WeakMap<object, Record<string, unknown>>();

export function moveApiPayload(tool: ToolCall): Record<string, unknown> {
  const source = moveApiSourceInput(tool);
  const cached = payloadCache.get(source);
  if (cached) return cached;

  const raw = source.data;
  let payload: Record<string, unknown>;
  if (raw === undefined || raw === null) {
    const { token: _token, data: _data, ...rest } = source;
    payload = rest;
  } else if (typeof raw === "string") {
    payload = parseObject(raw);
  } else if (typeof raw === "object" && !Array.isArray(raw)) {
    payload = raw as Record<string, unknown>;
  } else {
    payload = {};
  }

  payloadCache.set(source, payload);
  return payload;
}

/** An unparseable or non-object payload is rejected backend-side, so it carries no op. */
function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function moveApiOp(tool: ToolCall): string | null {
  const op = moveApiPayload(tool).op;
  return typeof op === "string" ? op : null;
}

export function moveApiInput(tool: ToolCall): Record<string, unknown> {
  return moveApiPayload(tool);
}

/** Latest top-level move call per reusable token, in transcript order. */
export function buildLatestMoveToolCallIds(messages: Message[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const message of messages) {
    const tools = message.toolCalls
      ?? message.contentBlocks
        ?.filter((block) => block.type === "tool_call")
        .map((block) => block.toolCall)
      ?? [];
    for (const tool of tools) {
      const token = moveApiToken(tool);
      if (token) latest.set(token, tool.id);
    }
  }
  return latest;
}

/** Keep move-owned rows out of collapsible core-tool runs. */
export function partitionToolRun(tools: ToolCall[]): ToolRunPartition[] {
  const partitions: ToolRunPartition[] = [];
  for (const tool of tools) {
    const moveApi = moveApiToken(tool) !== null;
    const current = partitions.at(-1);
    if (current?.moveApi === moveApi) current.tools.push(tool);
    else partitions.push({ moveApi, tools: [tool] });
  }
  return partitions;
}

function isResolution(value: unknown): value is MoveToolViewResolution {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MoveToolViewResolution>;
  return typeof candidate.moveName === "string"
    && typeof candidate.cwd === "string"
    && typeof candidate.instanceId === "string"
    && typeof candidate.sessionId === "string"
    && !!candidate.toolView
    && typeof candidate.toolView.component === "string";
}

async function fetchResolution(token: string): Promise<MoveToolViewResolution | null> {
  const response = await fetch(
    backendUrl(`/api/moves/resolve-token?token=${encodeURIComponent(token)}`),
    { headers: authHeaders() },
  );
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      const candidate = body.error ?? body.message;
      if (typeof candidate === "string") detail = candidate;
    } catch {}
    throw new Error(detail || `token resolution returned HTTP ${response.status}`);
  }
  const value: unknown = await response.json();
  if (!isResolution(value)) throw new Error("token resolution returned an invalid tool-view declaration");
  return value;
}

export function resolveMoveToolView(
  token: string,
  load: (token: string) => Promise<MoveToolViewResolution | null> = fetchResolution,
): Promise<MoveToolViewResolutionResult> {
  const cached = resolutionCache.get(token);
  if (cached) {
    const failedAt = negativeResolvedAt.get(token);
    // In-flight and successful lookups are shared; only an expired failure refetches.
    if (failedAt === undefined || Date.now() - failedAt < NEGATIVE_RESOLUTION_TTL_MS) return cached;
    resolutionCache.delete(token);
    negativeResolvedAt.delete(token);
  }
  const pending = load(token)
    .then((resolution): MoveToolViewResolutionResult => resolution
      ? { resolution, error: null }
      : { resolution: null, error: "token did not resolve to a declared tool view" })
    .catch((reason: unknown): MoveToolViewResolutionResult => ({
      resolution: null,
      error: reason instanceof Error ? reason.message : "token resolution failed",
    }));
  resolutionCache.set(token, pending);
  void pending.then((result) => {
    if (!result.resolution) negativeResolvedAt.set(token, Date.now());
  });
  return pending;
}

export function clearMoveToolViewResolutionCache(): void {
  resolutionCache.clear();
  negativeResolvedAt.clear();
}

export function moveToolViewModuleUrl(resolution: MoveToolViewResolution): string {
  const params = new URLSearchParams({
    cwd: resolution.cwd,
    component: resolution.toolView.component,
  });
  return backendUrl(`/api/moves/${encodeURIComponent(resolution.moveName)}/widget?${params}`);
}

export function moveToolViewCssUrl(resolution: MoveToolViewResolution): string {
  const params = new URLSearchParams({ cwd: resolution.cwd });
  return backendUrl(`/api/moves/${encodeURIComponent(resolution.moveName)}/widget.css?${params}`);
}
