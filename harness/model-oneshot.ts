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
 * state. It is deliberately *not* a second provider system — the default
 * transport resolves its model through `pi-model.ts`, the same seam the
 * agentic PI provider uses, so a one-shot and a session against the same
 * profile talk to the same endpoint with the same credentials. A second,
 * opt-in transport (`allowSubprocess`) launches the Claude CLI for one
 * headless turn (`providers/claude-cli-oneshot.ts`) — slower by seconds, but
 * it rides the CLI's own subscription auth instead of API credit. The two are
 * never silently interchangeable: results and records carry their transport.
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
  defaultPiModel,
  resolvePiApiKey,
} from "./providers/pi-model";
import {
  listOneShotProviders,
  listSubprocessOneShotProviders,
  supportsOneShotCompletion,
  supportsSubprocessOneShot,
} from "./providers/provider-names";
import { runClaudeCliOneShot, type CliOneShotOutcome, type CliOneShotRequest } from "./providers/claude-cli-oneshot";

// ── Types ──

/**
 * How the completion physically ran. `in-process` is pi-ai's HTTP call
 * (milliseconds); `subprocess` launches a provider CLI for one headless turn
 * (seconds, but the CLI's own auth — a subscription — pays for it). Carried on
 * every record and result so the two never become silently interchangeable.
 */
export type OneShotTransport = "in-process" | "subprocess";

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
  transport: OneShotTransport;
  /**
   * Why the model stopped, as pi-ai reports it: `stop` | `length` | `toolUse` |
   * `error` | `aborted`. Carried because `text` alone cannot distinguish "the
   * model said little" from "the answer was cut off at maxTokens" — a caller
   * writing a session title needs to know which. The subprocess transport
   * reports `stop` for any outcome it did not already throw on.
   */
  stopReason?: string;
  /** Wall-clock cost of the completion, so the latency difference between the
   *  transports stays visible instead of averaged away. */
  elapsedMs: number;
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
  /** Ignored on the subprocess transport — the CLI exposes no flag for either. */
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /**
   * Accept a provider that serves one-shots by launching its CLI for a single
   * headless turn (currently `claude-code-pty`). Off by default because the
   * launch costs seconds against milliseconds for the in-process providers —
   * the caller must knowingly trade latency for the CLI's subscription auth.
   */
  allowSubprocess?: boolean;
  origin: OneShotOrigin;
};

export type OneShotResult = {
  text: string;
  oneShotId: string;
  provider: string;
  model: string;
  usage?: OneShotUsage;
  transport: OneShotTransport;
  elapsedMs: number;
  /** See `OneShotRecord.stopReason`. `"length"` with non-empty text means the
   *  answer is real but truncated — the caller decides whether that is usable. */
  stopReason?: string;
};

// ── Target resolution ──

export type OneShotTarget = {
  provider: string;
  /** Empty string on the subprocess transport when nothing named a model —
   *  the CLI then uses its own default, and the record carries what it reports. */
  model: string;
  profileName?: string;
  /** The resolved profile, passed to buildPiModel for contextWindow/maxOutputTokens. */
  profile?: unknown;
  transport: OneShotTransport;
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
  allowSubprocess?: boolean;
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

  let transport: OneShotTransport = "in-process";
  if (!supportsOneShotCompletion(providerName)) {
    if (supportsSubprocessOneShot(providerName)) {
      if (!opts.allowSubprocess) {
        throw new Error(
          `one-shot: provider "${providerName}" serves one-shots by launching its CLI for a single headless turn — `
          + `seconds of startup against milliseconds for the in-process providers (${listOneShotProviders().join(", ")}). `
          + `Pass allowSubprocess: true to knowingly accept that, or use ctx.sessions.create() for a full session.`,
        );
      }
      transport = "subprocess";
    } else {
      throw new Error(
        `one-shot: provider "${providerName}" cannot answer a single prompt without spawning an agent session. `
        + `One-shot capable providers: ${listOneShotProviders().join(", ")}; `
        + `with allowSubprocess: true also ${listSubprocessOneShotProviders().join(", ")}. `
        + `Use ctx.sessions.create() if a full session is what you want.`,
      );
    }
  }

  // No default-model guess on the subprocess transport: the CLI has its own
  // default, and the PI defaults are meaningless outside the PI family.
  const model = opts.model ?? profile?.model
    ?? (transport === "subprocess" ? "" : defaultPiModel(providerName));

  return { provider: providerName, model, profileName: opts.profile, profile, transport };
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
 *
 * A dynamic import() rather than require(): pi-ai is "type": "module" and its
 * exports map declares only an "import" condition for ".", so there is no CJS
 * entry to require. Bun's runtime tolerates require() of ESM, which is why this
 * worked in dev, but Bun.build honours the exports conditions strictly and
 * failed to resolve it — breaking the desktop bundle while every test and
 * typecheck stayed green. Keep this an import().
 */
async function getLiveCompleter(): Promise<OneShotCompleter> {
  if (liveCompleter) return liveCompleter;
  const { completeSimple } = await import("@earendil-works/pi-ai");
  liveCompleter = ((model, context, options) =>
    completeSimple(model as any, context as any, options as any)) as OneShotCompleter;
  return liveCompleter;
}

export type SubprocessOneShotCompleter = (req: CliOneShotRequest) => Promise<CliOneShotOutcome>;

export async function runOneShot(
  req: OneShotRequest,
  deps: {
    complete?: OneShotCompleter;
    completeSubprocess?: SubprocessOneShotCompleter;
    lookupProfile?: OneShotTargetLookup;
  } = {},
): Promise<OneShotResult> {
  const prompt = String(req.prompt ?? "");
  if (!prompt.trim()) throw new Error("one-shot: prompt is required");

  const target = resolveOneShotTarget({
    profile: req.profile,
    provider: req.provider,
    model: req.model,
    cwd: req.origin.cwd,
    userProfile: req.origin.userProfile,
    allowSubprocess: req.allowSubprocess,
    lookupProfile: deps.lookupProfile,
  });

  const startedAt = Date.now();
  let text: string;
  let resolvedModel: string;
  let usage: OneShotUsage | undefined;
  let stopReason: string | undefined;

  if (target.transport === "subprocess") {
    const completeSubprocess = deps.completeSubprocess ?? runClaudeCliOneShot;
    const outcome = await completeSubprocess({
      prompt,
      system: req.system,
      model: target.model || undefined,
      effort: (target.profile as any)?.effort,
      cwd: req.origin.cwd,
      signal: req.signal,
    });
    text = outcome.text;
    // The CLI reports which model actually answered; prefer that over the
    // request, and never record the empty "CLI default" placeholder.
    resolvedModel = outcome.model ?? (target.model || "cli-default");
    usage = outcome.usage;
    // parseCliOneShotOutput throws on is_error or any non-success subtype, so
    // reaching here means the CLI finished normally. It exposes no finer-grained
    // stop reason than that.
    stopReason = "stop";
  } else {
    const model = buildPiModel(target.provider, target.model, target.profile);
    const complete = deps.complete ?? (await getLiveCompleter());

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

    text = extractCompletionText(completion);
    resolvedModel = target.model;
    usage = normalizeUsage(completion);
    stopReason = completion.stopReason;

    // A budget spent entirely on non-text blocks yields no answer at all, and
    // without this it returned success with text: "". Measured 2026-08-23 on
    // litellm/ornith-1-5-35b-q8: maxTokens 64 produced 64 output tokens, all of
    // them reasoning, which extractCompletionText drops by design — so the
    // caller saw an empty string, spent tokens, and had no way to tell why.
    // auto-title's `if (!title) return` turned that into a silent no-op.
    // Truncation with *some* text is left alone: a short answer is still an
    // answer, and stopReason now tells the caller it was cut off.
    if (!text && stopReason === "length") {
      const spent = usage?.output;
      throw new Error(
        `one-shot: ${target.provider}/${resolvedModel} produced no text — the completion hit its token limit`
        + `${req.maxTokens ? ` (maxTokens: ${req.maxTokens})` : ""}`
        + `${spent ? ` after ${spent} output tokens` : ""}`
        + `, all of them non-text. A reasoning model's thinking blocks are dropped on purpose, so a budget `
        + `smaller than its scratchpad returns nothing. Raise maxTokens, or disable thinking for this model.`,
      );
    }
  }

  const record: OneShotRecord = {
    id: nextOneShotId(),
    createdAt: Date.now(),
    profile: target.profileName,
    provider: target.provider,
    model: resolvedModel,
    system: req.system,
    prompt,
    text,
    usage,
    origin: req.origin,
    transport: target.transport,
    elapsedMs: Date.now() - startedAt,
    stopReason,
  };
  storeRecord(record);

  return {
    text,
    oneShotId: record.id,
    provider: record.provider,
    model: record.model,
    usage: record.usage,
    transport: record.transport,
    elapsedMs: record.elapsedMs,
    stopReason: record.stopReason,
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
