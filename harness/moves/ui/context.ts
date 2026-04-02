/**
 * ui move — gives the agent access to the user's viewing panel.
 *
 * Ops: open-file (show a file), get-pins (read pinned files),
 * set-pins (replace active pin group).
 */

import type { MoveContext } from "../../move-types";
import { createApiToken } from "../../modus-mcp";

export async function gather(ctx: MoveContext): Promise<string> {
  const apiToken = createApiToken(ctx.sessionId);

  return [
    "You have access to the user's viewing panel via `modus_submit`.",
    "",
    `Token: \`${apiToken}\``,
    "",
    "## Operations",
    "",
    "### open-file",
    "Open a file in the right panel for the user to see.",
    "```json",
    `{ "op": "open-file", "path": "/absolute/path/to/file" }`,
    "```",
    "",
    "### get-pins",
    "Retrieve the user's currently pinned files.",
    "```json",
    `{ "op": "get-pins" }`,
    "```",
    "",
    "### set-pins",
    "Replace the active pin group's files.",
    "```json",
    `{ "op": "set-pins", "paths": ["/path/a", "/path/b"] }`,
    "```",
    "",
    "Use these to surface relevant files as you work.",
    "Show files the user should see. Pin files they'll need to reference later.",
  ].join("\n");
}
