import type { ActionContext, RunResult, SessionTriggerPayload } from "../../action-types";
import { updateSessionTitle, addSessionTag } from "../../db";

export async function gather(ctx: ActionContext): Promise<string> {
  const payload = ctx.trigger.payload as SessionTriggerPayload;

  let context = `User message:\n"${payload.preview}"`;
  if (payload.lastResponse) {
    context += `\n\nAssistant response (truncated):\n"${payload.lastResponse}"`;
  }

  return (
    `Generate a concise title (3-6 words) for this conversation:\n\n` +
    `${context}\n\n` +
    `Respond with ONLY the title. No quotes, no punctuation at the end, no explanation.`
  );
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  const payload = ctx.trigger.payload as SessionTriggerPayload;

  if (!result.response) return;

  const title = result.response.trim().replace(/^["']|["']$/g, "").replace(/\.+$/, "");
  if (!title) return;

  updateSessionTitle(payload.sessionId, title);
  addSessionTag(payload.sessionId, "auto-titled");
}
