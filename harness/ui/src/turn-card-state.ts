import type { SessionTurnIndexEntry, ToolCall } from "../../sdk/index";
import { segmentMessage, type ChatTurn } from "./turn-segments";
import { canonicalToolName } from "./tool-names";

export type TurnActivity = {
  phase: "thinking" | "writing" | "tool" | "recent" | "error";
  label: string;
  detail?: string;
  activeCount?: number;
};

export type TurnNavigationEntry = {
  number: number;
  seq: number;
};

export type TurnNavigation = {
  current: number;
  total: number;
  previous: TurnNavigationEntry | null;
  next: TurnNavigationEntry | null;
  nextIsLatest: boolean;
};

export const TURN_FOLLOW_BOTTOM_PX = 48;
export const TURN_SCROLL_THROUGH_THRESHOLD_PX = 220;

export type TurnScrollThroughDirection = "previous" | "next";
export type TurnScrollThroughProgress = {
  direction: TurnScrollThroughDirection | null;
  distance: number;
};

export function canConsumeDirectionalScroll(
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
  deltaY: number,
  tolerance = 1,
): boolean {
  if (deltaY < 0) return metrics.scrollTop > tolerance;
  if (deltaY > 0) {
    return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight > tolerance;
  }
  return false;
}

export type TurnScrollThroughResult = {
  progress: TurnScrollThroughProgress;
  navigate: TurnScrollThroughDirection | null;
  consumed: boolean;
};

const EMPTY_SCROLL_THROUGH_PROGRESS: TurnScrollThroughProgress = {
  direction: null,
  distance: 0,
};

/**
 * Turn wheel navigation only accrues after the current turn has hit the edge.
 * Reversing direction or leaving that edge clears the gesture, so ordinary
 * reading scrolls cannot carry momentum into an accidental turn change.
 */
export function accumulateTurnScrollThrough(
  progress: TurnScrollThroughProgress,
  deltaY: number,
  options: {
    atTop: boolean;
    atBottom: boolean;
    canPrevious: boolean;
    canNext: boolean;
    threshold?: number;
  },
): TurnScrollThroughResult {
  const direction: TurnScrollThroughDirection | null = deltaY < 0
    ? "previous"
    : deltaY > 0
      ? "next"
      : null;
  const eligible = direction === "previous"
    ? options.atTop && options.canPrevious
    : direction === "next"
      ? options.atBottom && options.canNext
      : false;
  if (!eligible) {
    return { progress: EMPTY_SCROLL_THROUGH_PROGRESS, navigate: null, consumed: false };
  }

  const distance = (progress.direction === direction ? progress.distance : 0) + Math.abs(deltaY);
  if (distance < (options.threshold ?? TURN_SCROLL_THROUGH_THRESHOLD_PX)) {
    return { progress: { direction, distance }, navigate: null, consumed: true };
  }
  return { progress: EMPTY_SCROLL_THROUGH_PROGRESS, navigate: direction, consumed: true };
}

export function isNearTurnBottom(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= TURN_FOLLOW_BOTTOM_PX;
}

export function shouldAutoScrollTurn(
  latestTurn: boolean,
  following: boolean,
  clientHeight: number,
  scrollHeight: number,
): boolean {
  return latestTurn && following && scrollHeight > clientHeight + 1;
}

function truncate(value: string, max = 58): string {
  const oneLine = value.trim().replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return normalized.split("/").pop() ?? normalized;
}

function firstString(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")) {
      return value.join(" ");
    }
  }
  return "";
}

function toolDetail(tool: ToolCall): string | undefined {
  const path = firstString(tool.input, ["file_path", "filePath", "path", "notebook_path"]);
  if (path) return truncate(basename(path));
  const detail = firstString(tool.input, ["description", "command", "cmd", "script", "pattern", "query", "url"]);
  return detail ? truncate(detail) : undefined;
}

function describeTool(tool: ToolCall, completed: boolean): Pick<TurnActivity, "label" | "detail"> {
  const name = canonicalToolName(tool.name);
  const detail = toolDetail(tool);

  if (name === "read") return { label: completed ? "Read" : "Reading", detail };
  if (["write"].includes(name)) return { label: completed ? "Wrote" : "Writing", detail };
  if (["edit", "multiedit", "notebookedit", "applypatch", "filechange"].includes(name)) {
    return { label: completed ? "Edited" : "Editing", detail };
  }
  if (["commandexecution", "bash", "powershell", "shell", "exec"].includes(name)) {
    return { label: completed ? "Ran command" : "Running command", detail };
  }
  if (["grep", "glob", "find"].includes(name)) {
    return { label: completed ? "Searched project" : "Searching project", detail };
  }
  if (name === "ls") return { label: completed ? "Inspected folder" : "Inspecting folder", detail };
  if (name === "websearch") return { label: completed ? "Searched the web" : "Searching the web", detail };
  if (name === "webfetch") return { label: completed ? "Read web page" : "Reading web page", detail };
  if (["agent", "task", "workflow"].includes(name)) {
    return { label: completed ? "Finished delegated work" : "Coordinating work", detail };
  }
  if (["todowrite", "updateplan"].includes(name)) {
    return { label: completed ? "Updated plan" : "Updating plan", detail };
  }
  if (name === "mcptoolcall") {
    const server = firstString(tool.input, ["server"]);
    const operation = firstString(tool.input, ["tool", "name"]);
    const integration = [server, operation].filter(Boolean).join("/");
    return {
      label: completed ? "Called integration" : "Calling integration",
      detail: integration || detail,
    };
  }
  if (tool.name.startsWith("mcp__")) {
    const parts = tool.name.split("__").filter(Boolean);
    const integration = parts.length >= 3 ? `${parts[1]}/${parts[2]}` : parts[parts.length - 1];
    return { label: completed ? "Called integration" : "Calling integration", detail: integration };
  }
  return {
    label: completed ? "Finished tool call" : "Calling tool",
    detail: truncate(tool.name),
  };
}

/**
 * Describe only a turn that is still active. Once the terminal result lands the
 * indicator disappears; it is presence, not another durable transcript row.
 */
export function describeTurnActivity(
  turn: ChatTurn | null,
  sessionStatus: string | undefined,
): TurnActivity | null {
  if (sessionStatus === "starting") {
    return { phase: "thinking", label: "Starting agent" };
  }
  if (sessionStatus !== "running" || !turn) return null;

  const segments = turn.body.flatMap((message) => segmentMessage(message));
  const tools = segments.flatMap((segment) => segment.kind === "tools" ? segment.tools : []);
  const running = tools.filter((tool) => tool.status === "running");
  if (running.length > 0) {
    const latest = running[running.length - 1];
    return {
      phase: "tool",
      ...describeTool(latest, false),
      ...(running.length > 1 ? { activeCount: running.length } : {}),
    };
  }

  const last = segments[segments.length - 1];
  if (!last) return { phase: "thinking", label: "Thinking" };
  if (last.kind === "thinking" || last.kind === "deferred") {
    return { phase: "thinking", label: "Thinking" };
  }
  if (last.kind === "text") return { phase: "writing", label: "Writing response" };

  const latest = last.tools[last.tools.length - 1];
  if (!latest) return { phase: "thinking", label: "Thinking" };
  if (latest.status === "error") {
    const described = describeTool(latest, false);
    return { phase: "error", label: `${described.label} failed`, detail: described.detail };
  }
  return { phase: "recent", ...describeTool(latest, true) };
}

/** Merge the bodiless server index with whatever turns are already loaded. */
export function buildTurnNavigationEntries(
  index: SessionTurnIndexEntry[],
  loadedTurns: ChatTurn[],
): TurnNavigationEntry[] {
  const byNumber = new Map<number, TurnNavigationEntry>();
  for (const entry of index) byNumber.set(entry.number, { number: entry.number, seq: entry.seq });
  for (const turn of loadedTurns) {
    if (turn.seq != null) byNumber.set(turn.number, { number: turn.number, seq: turn.seq });
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

export function resolveTurnNavigation(
  entries: TurnNavigationEntry[],
  turn: ChatTurn | null,
): TurnNavigation | null {
  if (!turn || turn.seq == null || entries.length === 0) return null;
  const position = entries.findIndex((entry) => entry.number === turn.number);
  if (position < 0) return null;
  return {
    current: turn.number,
    total: entries[entries.length - 1]?.number ?? turn.number,
    previous: entries[position - 1] ?? null,
    next: entries[position + 1] ?? null,
    nextIsLatest: position + 1 === entries.length - 1,
  };
}
