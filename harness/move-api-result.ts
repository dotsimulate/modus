/**
 * Rendering of move-API op results for the `modus_submit` tool surface.
 *
 * A handler's return travels two roads: the HTTP route (`POST
 * /api/moves/:name/op`) serializes the whole object, but the MCP tool can only
 * answer with text — and it used to answer with `message` alone, silently
 * dropping every other key. An op returning `{ok: true, ms, usage}` read back
 * as a bare "OK". This module makes the two surfaces agree: `message` (or
 * `error`) stays the human-readable lead, and any remaining keys follow as a
 * fenced JSON block, the same shape the mission-command branch already uses.
 *
 * Lives outside modus-mcp.ts so it can be unit-tested without pulling the MCP
 * SDK, move-runner, and the DB into the test.
 */

export type MoveApiSubmitResult = {
  ok: boolean;
  message?: string;
  error?: string;
} & Record<string, unknown>;

/** Keys already rendered as prose, never repeated in the JSON block. */
const RENDERED_KEYS = new Set(["ok", "message", "error"]);

export function formatMoveApiResultText(result: MoveApiSubmitResult): string {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (RENDERED_KEYS.has(key) || value === undefined) continue;
    extras[key] = value;
  }

  const lead = result.ok
    ? result.message ?? (Object.keys(extras).length ? "" : "OK")
    : result.error ?? "Unknown error";

  if (Object.keys(extras).length === 0) return lead;

  const block = "```json\n" + JSON.stringify(extras, null, 2) + "\n```";
  return lead ? `${lead}\n${block}` : block;
}

/**
 * Peel host-specific tool result envelopes down to the move-api text the
 * formatter produced.
 *
 * Grok Build stores MCP results as
 * `{ type: "MCP", output: { OkayOutput: "<formatMoveApiResultText>" } }`
 * and shell output as byte arrays. Without this, tool-views never see `path`
 * (or any other structured field) even when the op succeeded.
 */
export function unwrapToolResultText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;

  // Byte-array JSON: [72, 101, 108, 108, 111]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isByte)) {
        return bytesToString(parsed as number[]);
      }
    } catch {
      // fall through
    }
  }

  if (!trimmed.startsWith("{")) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    const obj = parsed as Record<string, unknown>;

    const fromOutput = unwrapOutputField(obj.output);
    if (fromOutput != null) return fromOutput;

    if (typeof obj.OkayOutput === "string") return obj.OkayOutput;
    if (typeof obj.ErrorOutput === "string") return obj.ErrorOutput;
    if (typeof obj.output_for_prompt === "string") return obj.output_for_prompt;

    // { type: "Bash", output: [bytes], output_for_prompt?: "..." }
    if (Array.isArray(obj.output) && (obj.output as unknown[]).every(isByte)) {
      return bytesToString(obj.output as number[]);
    }
    const fileContent = obj.FileContent;
    if (fileContent && typeof fileContent === "object" && !Array.isArray(fileContent)) {
      const content = (fileContent as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  } catch {
    // Not JSON — leave the original tool text alone.
  }
  return text;
}

function isByte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function bytesToString(bytes: number[]): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    return bytes.map((b) => String.fromCharCode(b)).join("");
  }
}

function unwrapOutputField(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output) && output.length > 0 && output.every(isByte)) {
    return bytesToString(output as number[]);
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const obj = output as Record<string, unknown>;
  if (typeof obj.OkayOutput === "string") return obj.OkayOutput;
  if (typeof obj.ErrorOutput === "string") return obj.ErrorOutput;
  if (typeof obj.output_for_prompt === "string") return obj.output_for_prompt;
  if (Array.isArray(obj.output) && (obj.output as unknown[]).every(isByte)) {
    return bytesToString(obj.output as number[]);
  }
  return null;
}

/**
 * Reconstruct the canonical handler result represented by the tool text.
 *
 * The MCP surface carries only formatted text, so the caller supplies whether
 * the tool completed successfully. The formatter intentionally omits `ok` and
 * renders prose keys outside the JSON block; this inverse restores those keys
 * while keeping the two formatter fallbacks (`OK`, `Unknown error`) implicit.
 */
export function parseMoveApiResultText(text: string, ok: boolean): MoveApiSubmitResult {
  const unwrapped = unwrapToolResultText(text);
  const fenced = /(?:^|\n)```json\n([\s\S]*?)\n```\s*$/.exec(unwrapped);
  let lead = unwrapped;
  let extras: Record<string, unknown> = {};

  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[1]!);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        extras = parsed as Record<string, unknown>;
        lead = unwrapped.slice(0, fenced.index).trimEnd();
      }
    } catch {
      // A malformed or user-authored JSON fence is prose, not structured data.
    }
  }

  const result: MoveApiSubmitResult = { ok, ...extras };
  if (ok) {
    if (lead && !(lead === "OK" && Object.keys(extras).length === 0)) result.message = lead;
  } else if (lead && !(lead === "Unknown error" && Object.keys(extras).length === 0)) {
    result.error = lead;
  }
  return result;
}
