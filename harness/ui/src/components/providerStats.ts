import type { Message } from "../../../sdk/index";

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatProviderTokenUsage(
  _provider: string | undefined,
  inputTokens?: number,
  outputTokens?: number,
): string | null {
  if (inputTokens == null || outputTokens == null) return null;
  return `${fmtCompact(inputTokens + outputTokens)} tok`;
}

export function formatSidebarProviderStat(
  provider: string | null | undefined,
  stats: {
    model?: string | null;
    costUsd?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  },
): string | null {
  const model = stats.model?.toLowerCase() ?? "";
  const isClaudeModel = model.includes("claude");
  if (provider === "claude-code" || (!provider && isClaudeModel)) {
    if (stats.costUsd != null && stats.costUsd > 0) return `$${stats.costUsd.toFixed(3)}`;
  }
  if (stats.inputTokens == null || stats.outputTokens == null) return null;
  return `${fmtCompact(stats.inputTokens + stats.outputTokens)} tok`;
}

export function getLatestAssistantUsage(messages: Message[]): Message["meta"] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.meta) return msg.meta;
  }
  return null;
}
