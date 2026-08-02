/**
 * Turn statistics — the single derivation of a completed assistant turn's usage
 * from a provider `result` event.
 *
 * Two paths render the same turn: the live event reducer while it streams, and
 * history reconstruction after a reload. Both read the same `result` event, so
 * the derivation lives here rather than in either one. A rehydrated session then
 * shows exactly the stats it showed while it was running.
 *
 * This module is imported by the backend, the browser bundle, and the SDK types,
 * so it deliberately has no imports of its own.
 */

/** Cost, token, and context usage for one completed assistant turn. */
export type TurnMeta = {
  cost?: number;
  duration?: number;
  model?: string;
  turns?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Total context the model can hold. 0 when the provider does not report it. */
  contextWindow?: number;
  /** Prompt size of the turn's final API call. Absent when unreported. */
  contextTokensUsed?: number | null;
  /** Provider-computed context fill. Absent when unreported. */
  contextPercent?: number | null;
};

type ModelUsageEntry = {
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
};

function asModelUsage(raw: unknown): Record<string, ModelUsageEntry> | undefined {
  return raw && typeof raw === "object" ? raw as Record<string, ModelUsageEntry> : undefined;
}

/** The model that produced most of the turn's output. */
export function pickPrimaryModel(modelUsage: unknown, fallback: string): string {
  const entries = Object.entries(asModelUsage(modelUsage) ?? {});
  if (entries.length === 0) return fallback;
  let best = entries[0]!;
  for (let i = 1; i < entries.length; i++) {
    if ((entries[i]![1]?.outputTokens ?? 0) > (best[1]?.outputTokens ?? 0)) best = entries[i]!;
  }
  return best[0] || fallback;
}

/**
 * Read usage out of a provider `result` event.
 *
 * Cache tokens and the context window are authoritative in `modelUsage`, which
 * every Claude result carries; the top-level `cache_*` / `context_*` fields are
 * for providers that compute them directly (the PI family). Providers that
 * report neither leave `contextWindow` at 0, which is what suppresses the
 * context readout rather than showing a fabricated percentage.
 */
export function turnMetaFromResultEvent(event: unknown, fallbackModel = ""): TurnMeta {
  const m = (event ?? {}) as Record<string, any>;
  const usage = asModelUsage(m.modelUsage);
  let cacheRead: number = m.cache_read_tokens ?? 0;
  let cacheWrite: number = m.cache_write_tokens ?? 0;
  let contextWindow: number = m.context_window ?? 0;
  if (usage) {
    for (const model of Object.values(usage)) {
      if (cacheRead === 0) cacheRead += model?.cacheReadInputTokens ?? 0;
      if (cacheWrite === 0) cacheWrite += model?.cacheCreationInputTokens ?? 0;
      if (!contextWindow) contextWindow = model?.contextWindow ?? 0;
    }
  }
  return {
    cost: m.total_cost_usd,
    duration: m.harness_duration_ms,
    model: pickPrimaryModel(m.modelUsage, fallbackModel),
    turns: m.num_turns,
    inputTokens: m.input_tokens,
    outputTokens: m.output_tokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    contextWindow,
    contextTokensUsed: m.context_tokens_used,
    contextPercent: m.context_percent,
  };
}

/**
 * True when a turn carries anything worth rendering. A `result` event that
 * reported nothing at all would otherwise hydrate an empty stats row.
 */
export function hasTurnStats(meta: TurnMeta | undefined): boolean {
  if (!meta) return false;
  return meta.cost != null
    || meta.duration != null
    || meta.turns != null
    || meta.inputTokens != null
    || meta.outputTokens != null
    || !!meta.model
    || !!meta.contextWindow;
}
