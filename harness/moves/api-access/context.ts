/**
 * api-access move — injects an API token into the session prompt.
 *
 * The agent receives an opaque token it can use with modus_submit to
 * call registered API operations (tag-session, etc.) without ever
 * knowing the session ID.
 */

import type { MoveContext } from "../../move-types";
import { createApiToken } from "../../modus-mcp";

export async function gather(ctx: MoveContext): Promise<string> {
  const apiToken = createApiToken(ctx.sessionId);

  const ops = [
    {
      name: "tag-session",
      description: "Add a metadata tag to the current session",
      data: '{ "op": "tag-session", "tag": "<short descriptive tag>" }',
    },
    {
      name: "open-file",
      description: "Open a file in the UI viewer panel (RightPanel)",
      data: '{ "op": "open-file", "path": "<absolute file path>" }',
    },
  ];

  const lines = [
    "You now have access to the harness API via `modus_submit`.",
    "",
    `API token: \`${apiToken}\``,
    "",
    "Available operations:",
    "",
  ];

  for (const op of ops) {
    lines.push(`### ${op.name}`);
    lines.push(op.description);
    lines.push("```json");
    lines.push(`modus_submit({ token: "${apiToken}", data: ${op.data} })`);
    lines.push("```");
    lines.push("");
  }

  lines.push(
    "Use these operations when appropriate — for example, tag the session",
    "once you understand the main topic or complete a significant step.",
    "Do not over-tag. One or two meaningful tags per session is ideal.",
  );

  return lines.join("\n");
}
