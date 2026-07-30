/**
 * One-shot model completion — a model call with no session.
 *
 * Modus historically had exactly one way to reach a model: spawn a session
 * (`startSession`) and converse with a provider. That is the right shape for a
 * conversation and the wrong shape for the many sub-second transforms the
 * product wants — punctuating a dictated sentence, naming a session, writing a
 * commit message, translating a phrase. Doing those through a session costs a
 * process launch, a full agent turn, and a row in the user's session list.
 *
 * This module is the missing bottom rung: prompt in, text out, no tools, no
 * state, no subprocess. It is deliberately *not* a second provider system —
 * every one-shot resolves its model through `pi-model.ts`, the same seam the
 * agentic PI provider uses, so a one-shot and a session against the same
 * profile talk to the same endpoint with the same credentials.
 *
 * Promotion is the other half of the design. A one-shot answer you disagree
 * with is a dead end unless you can keep talking, so every call is recorded and
 * can be turned into a real session that opens with the original exchange.
 * Promotion itself lives in the Harness Context (it needs the session engine);
 * this module owns the record and the replay text.
 */

import { getProfile } from "./profiles";
import {
  buildPiModel,
  DEFAULT_PI_MODELS,
  resolvePiApiKey,
  type PiProviderName,
} from "./providers/pi-model";
import { ONE_SHOT_PROVIDERS, supportsOneShotCompletion } from "./providers/provider-names";

// ── Types ──

export type OneShotUsage = {
  input: number;
  output: number;
  totalTokens: number;
  costUsd: number;
};

/** Who ran a one-shot. Carried so promotion inherits the origin's project. */
export type OneShotOrigin = {
  kind: string;
  name: string;
  cwd: string;
  userProfile?: string;
  sessionId?: string | null;
};

export type OneShotRecord = {
  id: string;
  createdAt: number;
  /** Profile the target was resolved from, when one was named. */
  profile?: string;
  provider: string;
  model: string;
  system?: string;
  prompt: string;
  text: string;
  usage?: OneShotUsage;
  origin: OneShotOrigin;
  /**
   * Set once promoted. Promotion is idempotent — a second call returns the same
   * session rather than spawning a duplicate, because the caller is usually a UI
   * button and a double click must not cost two sessions.
   */
  promotedSessionId?: string;
};

export type OneShotRequest = {
  prompt: string;
  system?: string;
  /** Resolve provider + model from an agent profile. */
  profile?: string;
  /** Override the provider directly. Must be one-shot capable. */
  provider?: string;
  /** Override the model id. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  origin: OneShotOrigin;
};

export type OneShotResult = {
  text: string;
  oneShotId: string;
  provider: string;
  model: string;
  usage?: OneShotUsage;
};

// ── Target resolution ──

export type OneShotTarget = {
  provider: PiProviderName;
  model: string;
  profileName?: string;
  /** The resolved profile, passed to buildPiModel for contextWindow/maxOutputTokens. */
  profile?: unknown;
};

/**
 * Resolve which provider and model a one-shot should use.
 *
 * Pure apart from profile lookup, and it throws rather than falling back,
 * because every silent fallback here means spending tokens against a model the
 * caller did not choose. Note there is no global default provider in
 * `GlobalConfigSchema` — a profile that omits `provider` genuinely has nothing
 * to fall back to, so that case is an error and not an oversight.
 */
export function resolveOneShotTarget(opts: {
  profile?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  userProfile?: string;
  lookupProfile?: (name: string, cwd?: string, context?: { userProfile?: string }) => unknown;
}): OneShotTarget {
  const lookup = opts.lookupProfile ?? getProfile;
  let profile: any;

  if (opts.profile) {
    profile = lookup(opts.profile, opts.cwd, { userProfile: opts.userProfile });
    if (!profile) {
      throw new Error(`one-shot: agent profile "${opts.profile}" was not found`);
    }
  }

  const providerName = opts.provider ?? profile?.provider;
  if (!providerName) {
    throw new Error(
      opts.profile
        ? `one-shot: agent profile "${opts.profile}" declares no provider, and there is no global default — pass a provider explicitly`
        : "one-shot: pass a profile or an explicit provider",
    );
  }

  if (!supportsOneShotCompletion(providerName)) {
    throw new Error(
      `one-shot: provider "${providerName}" cannot answer a single prompt without spawning an agent session. `
      + `One-shot capable providers: ${ONE_SHOT_PROVIDERS.join(", ")}. `
      + `Use ctx.sessions.create() if a full session is what you want.`,
    );
  }

  const pi = providerName as PiProviderName;
  const model = opts.model ?? profile?.model ?? DEFAULT_PI_MODELS[pi] ?? "default";

  return { provider: pi, model, profileName: opts.profile, profile };
}

// ── Record store ──

/**
 * Bounded ring. Promotion is a human action taken shortly after the call, so a
 * short history is sufficient and an unbounded map would be a slow leak in a
 * long-running backend. Records are in-memory only: a promotion offered after a
 * restart would reference a call whose context is gone, which is worse than the
 * promote link simply not being there.
 */
export const ONE_SHOT_STORE_LIMIT = 50;

const records = new Map<string, OneShotRecord>();
let counter = 0;

function nextOneShotId(): string {
  counter += 1;
  return `os-${Date.now().toString(36)}-${counter.toString(36)}`;
}

function storeRecord(record: OneShotRecord): void {
  records.set(record.id, record);
  while (records.size > ONE_SHOT_STORE_LIMIT) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

export function getOneShotRecord(id: string): OneShotRecord | undefined {
  return records.get(id);
}

/** Newest first. */
export function listOneShotRecords(limit = 20): OneShotRecord[] {
  return Array.from(records.values()).reverse().slice(0, Math.max(0, limit));
}

export function recordOneShotPromotion(id: string, sessionId: string): void {
  const record = records.get(id);
  if (record) record.promotedSessionId = sessionId;
}

/** Test seam — the ring is module state. */
export function resetOneShotStore(): void {
  records.clear();
  counter = 0;
}

// ── Completion ──

/** Narrow view of what pi-ai's completeSimple returns, so stubs stay small. */
export type OneShotCompletion = {
  content?: Array<{ type: string; text?: string }>;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
};

export type OneShotCompleter = (
  model: unknown,
  context: { systemPrompt?: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
  options: { apiKey?: string; temperature?: number; maxTokens?: number; signal?: AbortSignal },
) => Promise<OneShotCompletion>;

/**
 * Join the text blocks of a completion.
 *
 * Thinking blocks are dropped on purpose. A reasoning model's scratchpad is not
 * output, and the first consumer of this is dictation cleanup — leaking "the
 * user probably meant…" into a transcript would be worse than no refinement at
 * all.
 */
export function extractCompletionText(completion: OneShotCompletion): string {
  return (completion.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("")
    .trim();
}

export function normalizeUsage(completion: OneShotCompletion): OneShotUsage | undefined {
  const usage = completion.usage;
  if (!usage) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
    costUsd: usage.cost?.total ?? 0,
  };
}

let liveCompleter: OneShotCompleter | null = null;

/**
 * Lazily bind pi-ai's completeSimple. Deferred rather than imported at module
 * top level so importing this module (for the record store, or for the pure
 * resolvers in a test) does not pull the provider SDK and its builtin registry.
 */
function getLiveCompleter(): OneShotCompleter {
  if (liveCompleter) return liveCompleter;
  const { completeSimple } = require("@mariozechner/pi-ai") as typeof import("@mariozechner/pi-ai");
  liveCompleter = ((model, context, options) =>
    completeSimple(model as any, context as any, options as any)) as OneShotCompleter;
  return liveCompleter;
}

export async function runOneShot(
  req: OneShotRequest,
  deps: { complete?: OneShotCompleter; lookupProfile?: OneShotTargetLookup } = {},
): Promise<OneShotResult> {
  const prompt = String(req.prompt ?? "");
  if (!prompt.trim()) throw new Error("one-shot: prompt is required");

  const target = resolveOneShotTarget({
    profile: req.profile,
    provider: req.provider,
    model: req.model,
    cwd: req.origin.cwd,
    userProfile: req.origin.userProfile,
    lookupProfile: deps.lookupProfile,
  });

  const model = buildPiModel(target.provider, target.model, target.profile);
  const complete = deps.complete ?? getLiveCompleter();

  const completion = await complete(
    model,
    {
      systemPrompt: req.system,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    {
      // Absent for a local Ollama or an open LiteLLM; PI's own auth path
      // substitutes a placeholder in that case, so undefined is not an error.
      apiKey: resolvePiApiKey(target.provider),
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      signal: req.signal,
    },
  );

  if (completion.stopReason === "error") {
    throw new Error(
      `one-shot: ${target.provider}/${target.model} failed — ${completion.errorMessage ?? "no error detail"}`,
    );
  }

  const text = extractCompletionText(completion);
  const record: OneShotRecord = {
    id: nextOneShotId(),
    createdAt: Date.now(),
    profile: target.profileName,
    provider: target.provider,
    model: target.model,
    system: req.system,
    prompt,
    text,
    usage: normalizeUsage(completion),
    origin: req.origin,
  };
  storeRecord(record);

  return {
    text,
    oneShotId: record.id,
    provider: record.provider,
    model: record.model,
    usage: record.usage,
  };
}

type OneShotTargetLookup = (
  name: string,
  cwd?: string,
  context?: { userProfile?: string },
) => unknown;

// ── Promotion ──

/**
 * The opening message of a promoted session.
 *
 * Replay, not restore. Rebuilding provider-side history is a different and much
 * harder problem (see docs/checkpoint-rewind-decisions-2026-07-11.md) and it
 * would only work for the providers that support resume. Replaying the exchange
 * as the first user message works for every provider and is honest about what
 * the session knows: it was handed a transcript, it did not live through it.
 */
export function buildPromotionPrompt(record: OneShotRecord): string {
  const parts = [
    "This session continues a one-shot model call. The exchange below already happened — treat it as the first turn, then respond to it.",
  ];
  if (record.system) {
    parts.push(`## Original instructions\n\n${record.system}`);
  }
  parts.push(`## Request\n\n${record.prompt}`);
  parts.push(`## Previous answer (${record.provider}/${record.model})\n\n${record.text || "(empty)"}`);
  return parts.join("\n\n");
}
