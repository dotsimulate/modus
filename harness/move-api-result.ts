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
