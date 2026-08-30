import type { ActionConfig, ActionContent, ActionCompletionMetadata } from "./action-types";
import type { HarnessModel } from "./harness-context";

const COMPLETION_UNSUPPORTED_FIELDS: Array<keyof ActionConfig> = [
  "steps",
  "maxTurns",
  "effort",
  "tools",
  "disallowedTools",
  "providerControls",
  "loadProjectSettings",
  "moves",
  "skills",
];

export function actionAnswerer(config: Pick<ActionConfig, "answerer">): "session" | "completion" {
  return config.answerer === "completion" ? "completion" : "session";
}

export function completionActionConfigError(config: ActionConfig): string | null {
  const authoredAnswerer = (config as { answerer?: unknown }).answerer;
  if (authoredAnswerer !== undefined && authoredAnswerer !== "session" && authoredAnswerer !== "completion") {
    return `action "${config.name}" answerer must be "session" or "completion"`;
  }
  if (actionAnswerer(config) !== "completion") return null;
  const conflicts = COMPLETION_UNSUPPORTED_FIELDS.filter((field) => config[field] !== undefined);
  if (conflicts.length === 0) return null;
  return `completion-answered action "${config.name}" cannot configure session-only fields: ${conflicts.join(", ")}`;
}

export function completionPrompt(content: ActionContent, actionName: string): string {
  if (typeof content === "string") return content;
  throw new Error(
    `completion-answered action "${actionName}" requires gather() to return a string; multipart text/image content requires a session answerer`,
  );
}

export async function answerWithCompletion(opts: {
  actionName: string;
  prompt: ActionContent;
  profile: string;
  provider?: string;
  model?: string;
  completer: Pick<HarnessModel, "complete">;
}): Promise<{ response: string; summary: string; costUsd: number; completion: ActionCompletionMetadata }> {
  const result = await opts.completer.complete({
    prompt: completionPrompt(opts.prompt, opts.actionName),
    profile: opts.profile,
    provider: opts.provider,
    model: opts.model,
  });
  return {
    response: result.text,
    summary: result.text.slice(0, 500),
    costUsd: result.usage?.costUsd ?? 0,
    completion: {
      oneShotId: result.oneShotId,
      provider: result.provider,
      model: result.model,
      transport: result.transport,
      elapsedMs: result.elapsedMs,
      usage: result.usage,
      stopReason: result.stopReason,
    },
  };
}
