import type { Message, TurnMeta } from "../../../sdk/index";
import { isCodexProvider } from "../tools";

/**
 * Context fill as a whole-number percentage, or null when the provider does not
 * report it. Only the Claude and PI families carry the figures today, so a null
 * here means "unreported", never "empty" — callers omit the readout rather than
 * showing a fabricated 0%.
 */
export function formatContextPercent(meta: TurnMeta | null | undefined): string | null {
  if (!meta?.contextWindow) return null;
  if (meta.contextPercent != null) return `${Math.round(meta.contextPercent)}%`;
  if (meta.contextTokensUsed == null || meta.contextTokensUsed <= 0) return null;
  return `${Math.round((meta.contextTokensUsed / meta.contextWindow) * 100)}%`;
}

/** Numeric context fill, for threshold styling. Null when unreported. */
export function contextFillRatio(meta: TurnMeta | null | undefined): number | null {
  if (!meta?.contextWindow) return null;
  if (meta.contextPercent != null) return meta.contextPercent / 100;
  if (meta.contextTokensUsed == null || meta.contextTokensUsed <= 0) return null;
  return meta.contextTokensUsed / meta.contextWindow;
}

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

function formatTokensPerSecond(meta: Message["meta"], provider?: string): string | null {
  if (isCodexProvider(provider)) return null;
  if (!meta?.outputTokens || !meta.duration || meta.duration <= 0) return null;
  const rate = meta.outputTokens / (meta.duration / 1000);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return `${rate >= 10 ? rate.toFixed(0) : rate.toFixed(1)} tok/s`;
}

/** When the turn landed, and how long it took. Either half can be missing. */
function formatMetaWhen(msg: Message): string | null {
  const elapsed = msg.meta?.duration != null ? `${(msg.meta.duration / 1000).toFixed(1)}s` : null;
  const clock = msg.timestamp
    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : null;
  if (clock && elapsed) return `${clock} (${elapsed})`;
  return clock ?? elapsed;
}

export type MetaPart = { key: string; className?: string; text: string };

/**
 * A turn's stats as an ordered part list.
 *
 * Returned as data rather than markup because the transcript renders it twice —
 * once as the text a resolve animation reveals, once as the settled row — and
 * building those separately let the two drift, so the animation used to finish
 * on text the row then replaced. Every surface that shows turn stats reads this
 * one list for the same reason.
 */
export function metaParts(msg: Message, provider?: string): MetaPart[] {
  const meta = msg.meta;
  if (!meta) return [];
  const parts: MetaPart[] = [];
  if (meta.model) parts.push({ key: "model", text: meta.model });
  if (meta.cost != null) parts.push({ key: "cost", text: `$${meta.cost.toFixed(4)}` });
  if (meta.turns != null) parts.push({ key: "turns", text: `${meta.turns} turns` });
  const usage = formatProviderTokenUsage(provider, meta.inputTokens, meta.outputTokens);
  if (usage) parts.push({ key: "tokens", className: "meta-tokens", text: usage });
  const tokensPerSecond = formatTokensPerSecond(meta, provider);
  if (tokensPerSecond) parts.push({ key: "rate", className: "meta-tokens", text: tokensPerSecond });
  const ctx = formatContextPercent(meta);
  if (ctx) parts.push({ key: "ctx", className: "meta-context", text: `${ctx} ctx` });
  const when = formatMetaWhen(msg);
  if (when) parts.push({ key: "when", className: "meta-duration", text: when });
  return parts;
}

export function getLatestAssistantUsage(messages: Message[]): Message["meta"] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.meta) return msg.meta;
  }
  return null;
}
