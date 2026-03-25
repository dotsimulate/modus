import { writeFileSync } from "fs";
import { join } from "path";
import type { ScheduleContext, RunResult } from "../../scheduler-types";

const vibes = [
  "late-night grind",
  "deep focus session",
  "building something cool",
  "pushing through the hard part",
  "making progress even when it doesn't feel like it",
  "quiet hours where the real work happens",
  "another session of turning ideas into reality",
];

export async function gather(ctx: ScheduleContext): Promise<string> {
  const hour = new Date().getHours();
  const vibe = vibes[ctx.runNumber % vibes.length];

  const timeContext =
    hour >= 0 && hour < 6
      ? "It's deep night. Dot's probably in the zone or should consider rest."
      : hour < 12
        ? "It's morning. Fresh start energy."
        : hour < 18
          ? "Afternoon. Steady progress time."
          : "Evening. The night owl hours are kicking in.";

  const previousMessages = ctx.db.getRunSummaries(5);
  const history = previousMessages.length > 0
    ? `\n\nYour previous messages (don't repeat yourself):\n${previousMessages.map(
        s => `- ${s.summary}`
      ).join("\n")}`
    : "";

  return (
    `You're dropping a quick motivational message for dot. This is run #${ctx.runNumber}.\n\n` +
    `${timeContext}\n` +
    `Current vibe: ${vibe}.\n\n` +
    `Write a short, genuine, friendly message (1-3 sentences). ` +
    `Not cheesy, not corporate, not over-the-top. Like a friend checking in. ` +
    `Match dot's energy — casual, real, maybe a little funny. ` +
    `Vary the style: sometimes encouraging, sometimes chill, sometimes a gentle nudge to take a break. ` +
    `Don't use emojis. Don't start with "Hey dot" every time — mix it up.` +
    history
  );
}

const DISPLAY_PATH = join(import.meta.dir, "../../../archive/motivation-display.html");

function buildHtml(message: string, timestamp: string): string {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="15">
<title>motivation</title>
<style>
body {
  background: #0a0a0a;
  color: #e0e0e0;
  font-family: 'Cascadia Code', 'SF Mono', monospace;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 2rem;
  margin: 0;
}
.msg {
  font-size: 1.4rem;
  line-height: 1.6;
  color: #c8f7c5;
  max-width: 600px;
  text-align: center;
}
.meta {
  font-size: 0.75rem;
  color: #444;
  margin-top: 2rem;
  text-align: center;
}
</style>
</head>
<body>
<div>
<p class="msg">${escaped}</p>
<p class="meta">${timestamp} // refreshes every 15s</p>
</div>
</body>
</html>`;
}

/**
 * afterRun — rewrites the motivation-display.html with the latest message.
 * Open that file in a browser and it auto-refreshes every 15s.
 */
export async function afterRun(ctx: ScheduleContext, result: RunResult): Promise<void> {
  if (result.status === "error" || !result.response) return;

  const msg = result.response.trim();
  const timestamp = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  writeFileSync(DISPLAY_PATH, buildHtml(msg, timestamp), "utf-8");
  console.log(`[motivation] run #${ctx.runNumber} → wrote display: ${msg.slice(0, 80)}`);
}
