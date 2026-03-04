import type { ScheduleContext } from "../../scheduler-types";

export async function gather(ctx: ScheduleContext): Promise<string> {
  const summaries = ctx.db.getRunSummaries(20);

  const pastContext = summaries.length > 0
    ? `\n\nPrevious run summaries (oldest → newest):\n${summaries.map(
        s => `- Run #${s.runNumber} (${new Date(s.completedAt).toLocaleString()}): ${s.summary}`
      ).join("\n")}`
    : "\n\nThis is the first run — no previous history.";

  return (
    `You are running as a scheduled heartbeat agent (run #${ctx.runNumber}). ` +
    `Current time: ${new Date().toISOString()}. ` +
    `Report a brief system status check. Be concise (2-3 sentences).` +
    pastContext
  );
}
