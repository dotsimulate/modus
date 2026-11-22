import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * agy's own record of a conversation: one JSON line per step, written as each
 * step completes (agy 1.5.9). It is not an ACP surface. Modus reads it for what
 * ACP cannot tell it: which background tasks agy is still waiting on, and that
 * one finished and agy woke.
 *
 * agy only streams `session/update`s, and only asks for tool approval, while a
 * `session/prompt` is open. Between prompts it still runs: a background task
 * that finishes posts a SYSTEM_MESSAGE step and agy starts working, but none of
 * that reaches the client, and any step that needs approval waits for the next
 * prompt (agy worker log: "Stream goroutine exited" when a prompt returns,
 * "Starting conversation update stream" only when the next one arrives).
 */
export function antigravityTranscriptPath(providerSessionId: string, home = homedir()): string {
  return join(home, ".gemini", "antigravity-cli", "brain", providerSessionId, ".system_generated", "logs", "transcript.jsonl");
}

export type AntigravityTranscriptStep = {
  step_index?: number;
  source?: string;
  type?: string;
  created_at?: string;
  content?: string;
  /** A model response's tool calls; each argument is recorded as JSON text. */
  tool_calls?: Array<{ name?: string; args?: Record<string, unknown> }>;
};

/** Reads the steps appended since it was opened, without rereading the file. */
export class AntigravityTranscriptTail {
  private offset: number;
  private remainder = Buffer.alloc(0);

  constructor(readonly path: string) {
    // A conversation's first turn creates the file, so a missing one starts at 0.
    this.offset = fileSize(path);
  }

  /** agy keeps this record; an agy that does not leaves Modus with ACP alone. */
  get exists(): boolean {
    return existsSync(this.path);
  }

  read(): AntigravityTranscriptStep[] {
    const size = fileSize(this.path);
    if (size < this.offset) {
      // Rewritten underneath us; start over rather than read mid-line.
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
    }
    if (size === this.offset) return [];
    let chunk: Buffer;
    try {
      const fd = openSync(this.path, "r");
      try {
        chunk = Buffer.alloc(size - this.offset);
        const read = readSync(fd, chunk, 0, chunk.length, this.offset);
        chunk = chunk.subarray(0, read);
      } finally {
        closeSync(fd);
      }
    } catch {
      return [];
    }
    this.offset += chunk.length;
    const data = Buffer.concat([this.remainder, chunk]);
    const lastNewline = data.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      this.remainder = data;
      return [];
    }
    this.remainder = data.subarray(lastNewline + 1);
    const steps: AntigravityTranscriptStep[] = [];
    for (const line of data.subarray(0, lastNewline).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const step = JSON.parse(line);
        if (step && typeof step === "object") steps.push(step);
      } catch {}
    }
    return steps;
  }
}

function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * A tool moved to the background: `{ taskId, description }`. For `run_command`
 * the description is the whole command line, every line of it; for `schedule`
 * it is agy's timer line (`Timer: 25s, Prompt: ...`).
 */
export function backgroundTaskStarted(step: AntigravityTranscriptStep): { taskId: string; description: string } | null {
  if (typeof step.content !== "string") return null;
  const match = /running as a background task with task id: (\S+)[ \t]*\r?\nTask Description: ([\s\S]*?)(?:\r?\n(?:Task logs are available at:|Log output:|YOU MUST TAKE )|$)/
    .exec(step.content);
  return match ? { taskId: match[1] ?? "", description: normalizedText(match[2] ?? "") } : null;
}

/** A `schedule` timer's length in seconds, from its task description; null for any other task. */
export function timerSeconds(description: string): number | null {
  const match = /^Timer: (\d+(?:\.\d+)?)s\b/.exec(description);
  return match ? Number(match[1]) : null;
}

/**
 * The SYSTEM_MESSAGE agy posts when a background task ends, with its result:
 * `Task id "..." finished with result:`, or `was canceled with result:` when
 * the task was stopped.
 */
export function backgroundTaskFinished(
  step: AntigravityTranscriptStep,
): { taskId: string; output: string; canceled: boolean } | null {
  if (step.source !== "SYSTEM" || typeof step.content !== "string") return null;
  const match = /Task id "([^"]+)" ([a-z]+(?: [a-z]+)?) with result:\s*([\s\S]*?)\s*(?:<\/SYSTEM_MESSAGE>\s*)?$/.exec(step.content);
  if (!match) return null;
  return {
    taskId: match[1] ?? "",
    output: (match[3] ?? "").replace(/\r+\n/g, "\n"),
    canceled: /cancel/.test(match[2] ?? ""),
  };
}

/** agy's notice that a restart stopped every background task it had. */
export function backgroundTasksStopped(step: AntigravityTranscriptStep): boolean {
  return isSystemMessage(step) && typeof step.content === "string"
    && step.content.includes("background tasks have been stopped");
}

/** A message agy posts to itself, such as a background task's finish; not a compaction checkpoint. */
export function isSystemMessage(step: AntigravityTranscriptStep): boolean {
  return step.source === "SYSTEM" && (step.type === undefined || step.type === "SYSTEM_MESSAGE");
}

/** A model response. One that follows a system message means agy has taken that message in. */
export function isModelResponse(step: AntigravityTranscriptStep): boolean {
  return step.source === "MODEL" && step.type === "PLANNER_RESPONSE";
}

/**
 * agy started a step on its own after `since`: a SYSTEM step, which only agy
 * posts, or a model step created after that time. Timestamps have one-second
 * resolution, so a model step from the second the prompt returned in does not
 * count; the SYSTEM_MESSAGE that wakes agy always comes first.
 */
export function stepIsWake(step: AntigravityTranscriptStep, since: number): boolean {
  if (step.source !== "SYSTEM" && step.source !== "MODEL") return false;
  const at = typeof step.created_at === "string" ? Date.parse(step.created_at) : NaN;
  const sinceSecond = Math.floor(since / 1_000) * 1_000;
  if (step.source === "SYSTEM") return !Number.isFinite(at) || at >= sinceSecond;
  return Number.isFinite(at) && at > sinceSecond;
}

/**
 * Whether steps read in order after a prompt returned at `since` show agy
 * working on its own: a system message no model response has followed yet, or a
 * model step agy started after the prompt returned. A system message with a
 * response after it was taken in by the run that prompt streamed, however late
 * Modus reads it.
 */
export function agyWoke(steps: AntigravityTranscriptStep[], since: number): boolean {
  let lastResponse = -1;
  steps.forEach((step, index) => { if (isModelResponse(step)) lastResponse = index; });
  return steps.some((step, index) =>
    (isSystemMessage(step) && index > lastResponse) || (step.source === "MODEL" && stepIsWake(step, since)));
}

/**
 * Whether steps read in order end with a completed model reply (no pending
 * tool calls) after any system message. Used to recognize when agy 1.5.10+
 * finished a post-wake run that streamed without a wake prompt.
 */
export function endsWithFinalResponse(steps: AntigravityTranscriptStep[]): boolean {
  const last = steps[steps.length - 1];
  if (!last || !isModelResponse(last)) return false;
  const calls = Array.isArray(last.tool_calls) ? last.tool_calls : [];
  return calls.length === 0;
}

/** agy records tool arguments as JSON text, so a command line can arrive quoted. */
export function commandLineText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return normalizedText(parsed);
    } catch {}
  }
  return normalizedText(text);
}

/** Line endings and outer whitespace can differ between ACP and agy's record; nothing else may. */
function normalizedText(text: string): string {
  return text.replace(/\r+\n?/g, "\n").trim();
}
