import type { ActionContext, RunResult, SessionTriggerPayload } from "../../action-types";

/** Long enough to name any conversation; short enough that a bad answer is obvious. */
const MAX_TITLE_LENGTH = 80;

export async function gather(ctx: ActionContext): Promise<string | null> {
  const payload = ctx.trigger.payload as SessionTriggerPayload | undefined;
  if (!payload?.sessionId) {
    throw new Error("auto-title requires a session trigger payload — it cannot be run manually");
  }

  // A session already carrying a title was named by the user or by a previous
  // run. Returning null skips the run without spending a completion on it.
  if (payload.title) return null;

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

/**
 * Strip what a model adds around a title it was asked to give bare: wrapping
 * quotes, a trailing period, a "Title:" preamble. Returns null when nothing
 * usable survives, so afterRun can leave the session alone rather than writing
 * an empty or absurd title over a perfectly good preview.
 */
export function cleanTitle(raw: string): string | null {
  const collapsed = raw.trim().split(/\r?\n/)[0]?.trim() ?? "";
  const unlabelled = collapsed.replace(/^title:\s*/i, "");
  const unquoted = unlabelled.replace(/^["'“”']+|["'“”']+$/g, "").trim();
  const cleaned = unquoted.replace(/[.]+$/, "").trim();
  if (!cleaned || cleaned.length > MAX_TITLE_LENGTH) return null;
  return cleaned;
}

export async function afterRun(ctx: ActionContext, result: RunResult): Promise<void> {
  const payload = ctx.trigger.payload as SessionTriggerPayload | undefined;
  if (!payload?.sessionId || !result.response) return;

  const title = cleanTitle(result.response);
  if (!title) {
    ctx.log("discarded an unusable title", { sessionId: payload.sessionId, response: result.response.slice(0, 200) });
    return;
  }

  ctx.db.updateSessionTitle(payload.sessionId, title);
  ctx.db.addSessionTag(payload.sessionId, "auto-titled");
}
