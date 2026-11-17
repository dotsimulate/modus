import { closeSync, openSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * agy's own record of a conversation: one JSON line per step, written as each
 * step completes (agy 1.5.9). It is not an ACP surface. Modus reads it for one
 * thing ACP cannot tell it: that a backgrounded command finished and agy woke.
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
};

/** Reads the steps appended since it was opened, without rereading the file. */
export class AntigravityTranscriptTail {
  private offset: number;
  private remainder = Buffer.alloc(0);

  constructor(readonly path: string) {
    // A conversation's first turn creates the file, so a missing one starts at 0.
    this.offset = fileSize(path);
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

/** `run_command` moved to the background: `{ taskId, description }`, where the description is the command line. */
export function backgroundTaskStarted(step: AntigravityTranscriptStep): { taskId: string; description: string } | null {
  const match = typeof step.content === "string"
    && /running as a background task with task id: (\S+)\s*\r?\nTask Description: ([^\r\n]*)/.exec(step.content);
  return match ? { taskId: match[1] ?? "", description: (match[2] ?? "").trim() } : null;
}

/** The SYSTEM_MESSAGE agy posts when a background task finishes, with the command's result. */
export function backgroundTaskFinished(step: AntigravityTranscriptStep): { taskId: string; output: string } | null {
  if (step.source !== "SYSTEM" || typeof step.content !== "string") return null;
  const match = /Task id "([^"]+)" finished with result:\s*([\s\S]*?)\s*(?:<\/SYSTEM_MESSAGE>\s*)?$/.exec(step.content);
  return match ? { taskId: match[1] ?? "", output: (match[2] ?? "").replace(/\r+\n/g, "\n") } : null;
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

/** agy records tool arguments as JSON text, so a command line can arrive quoted. */
export function commandLineText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") return parsed.trim();
    } catch {}
  }
  return text;
}
