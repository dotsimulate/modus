/**
 * One-shot completion tests.
 *
 * Target resolution, the record ring, and text extraction are pure enough to
 * test directly; the completion call is exercised through an injected completer
 * so no test reaches a model. The negative tests are the point: a one-shot that
 * silently falls back to a different provider, or to spawning a session, defeats
 * the reason the primitive exists.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  buildPromotionPrompt,
  extractCompletionText,
  getOneShotRecord,
  listOneShotRecords,
  normalizeUsage,
  ONE_SHOT_STORE_LIMIT,
  recordOneShotPromotion,
  resetOneShotStore,
  resolveOneShotTarget,
  runOneShot,
  type OneShotRecord,
} from "./model-oneshot";

const origin = { kind: "move", name: "t", cwd: "/proj", userProfile: "u", sessionId: "ses-1" };

/** Profile lookup stub — keeps resolution off disk and out of the user's home. */
function profiles(map: Record<string, unknown>) {
  return (name: string) => map[name];
}

beforeEach(() => {
  resetOneShotStore();
});

describe("target resolution", () => {
  test("resolves provider and model from a named profile", () => {
    const target = resolveOneShotTarget({
      profile: "cleanup",
      lookupProfile: profiles({ cleanup: { provider: "ollama", model: "qwen2.5:7b" } }),
    });
    expect(target.provider).toBe("ollama");
    expect(target.model).toBe("qwen2.5:7b");
    expect(target.profileName).toBe("cleanup");
  });

  test("an explicit provider and model need no profile", () => {
    const target = resolveOneShotTarget({ provider: "litellm", model: "gpt-4o-mini" });
    expect(target.provider).toBe("litellm");
    expect(target.model).toBe("gpt-4o-mini");
    expect(target.profileName).toBeUndefined();
  });

  test("an explicit override beats the profile", () => {
    const target = resolveOneShotTarget({
      profile: "cleanup",
      provider: "litellm",
      model: "override",
      lookupProfile: profiles({ cleanup: { provider: "ollama", model: "qwen2.5:7b" } }),
    });
    expect(target.provider).toBe("litellm");
    expect(target.model).toBe("override");
  });

  test("falls back to the provider's default model, not to a guess", () => {
    const target = resolveOneShotTarget({
      profile: "cleanup",
      lookupProfile: profiles({ cleanup: { provider: "openrouter" } }),
    });
    expect(target.model).toBe("anthropic/claude-sonnet-4.5");
  });

  test("a CLI provider is refused, and the message says what to use instead", () => {
    expect(() => resolveOneShotTarget({ provider: "claude-code" }))
      .toThrow(/cannot answer a single prompt/);
    expect(() => resolveOneShotTarget({ provider: "claude-code" }))
      .toThrow(/openai-compat, ollama, openrouter/);
    expect(() => resolveOneShotTarget({ provider: "codex" }))
      .toThrow(/ctx\.sessions\.create/);
  });

  test("a missing profile is an error, not a silent default", () => {
    expect(() => resolveOneShotTarget({ profile: "nope", lookupProfile: profiles({}) }))
      .toThrow(/agent profile "nope" was not found/);
  });

  test("a profile with no provider is an error — there is no global default to fall back to", () => {
    expect(() => resolveOneShotTarget({
      profile: "bare",
      lookupProfile: profiles({ bare: { model: "something" } }),
    })).toThrow(/declares no provider/);
  });

  test("naming neither a profile nor a provider is an error", () => {
    expect(() => resolveOneShotTarget({})).toThrow(/pass a profile or an explicit provider/);
  });
});

describe("completion", () => {
  const completer = (text: string) => async () => ({
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 10, output: 4, totalTokens: 14, cost: { total: 0.002 } },
  });

  test("returns the text, the target, and a promotable id", async () => {
    const result = await runOneShot(
      { prompt: "fix this", provider: "ollama", model: "m", origin },
      { complete: completer("Fixed this.") },
    );
    expect(result.text).toBe("Fixed this.");
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("m");
    expect(result.oneShotId).toMatch(/^os-/);
    expect(result.usage).toEqual({ input: 10, output: 4, totalTokens: 14, costUsd: 0.002 });
  });

  test("records the call so it can be promoted later", async () => {
    const result = await runOneShot(
      { prompt: "fix this", profile: "cleanup", origin },
      {
        complete: completer("Fixed."),
        lookupProfile: profiles({ cleanup: { provider: "ollama", model: "m" } }),
      },
    );
    const record = getOneShotRecord(result.oneShotId);
    expect(record?.prompt).toBe("fix this");
    expect(record?.text).toBe("Fixed.");
    expect(record?.profile).toBe("cleanup");
    expect(record?.origin.cwd).toBe("/proj");
  });

  test("passes the prompt through as a single user message", async () => {
    let seen: any = null;
    await runOneShot(
      { prompt: "hello", system: "be terse", provider: "ollama", origin },
      {
        complete: async (_model, context) => {
          seen = context;
          return { content: [{ type: "text", text: "hi" }], stopReason: "stop" };
        },
      },
    );
    expect(seen.systemPrompt).toBe("be terse");
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0].role).toBe("user");
    expect(seen.messages[0].content).toBe("hello");
  });

  test("forwards temperature and maxTokens rather than dropping them", async () => {
    let opts: any = null;
    await runOneShot(
      { prompt: "x", provider: "ollama", temperature: 0.1, maxTokens: 64, origin },
      {
        complete: async (_m, _c, o) => {
          opts = o;
          return { content: [{ type: "text", text: "y" }], stopReason: "stop" };
        },
      },
    );
    expect(opts.temperature).toBe(0.1);
    expect(opts.maxTokens).toBe(64);
  });

  test("an upstream error becomes a throw naming the target", async () => {
    await expect(runOneShot(
      { prompt: "x", provider: "ollama", model: "m", origin },
      { complete: async () => ({ stopReason: "error", errorMessage: "connection refused" }) },
    )).rejects.toThrow(/ollama\/m failed — connection refused/);
  });

  test("an empty prompt is refused before any model call", async () => {
    let called = false;
    await expect(runOneShot(
      { prompt: "   ", provider: "ollama", origin },
      { complete: async () => { called = true; return {}; } },
    )).rejects.toThrow(/prompt is required/);
    expect(called).toBe(false);
  });
});

describe("text extraction", () => {
  test("joins text blocks", () => {
    expect(extractCompletionText({ content: [
      { type: "text", text: "Hello " },
      { type: "text", text: "world." },
    ] })).toBe("Hello world.");
  });

  test("drops thinking blocks — a scratchpad is not output", () => {
    expect(extractCompletionText({ content: [
      { type: "thinking", text: "the user probably meant" },
      { type: "text", text: "Real answer." },
    ] })).toBe("Real answer.");
  });

  test("an answerless completion yields empty string, not undefined", () => {
    expect(extractCompletionText({})).toBe("");
    expect(extractCompletionText({ content: [] })).toBe("");
  });

  test("usage is absent rather than zeroed when the provider reports none", () => {
    expect(normalizeUsage({})).toBeUndefined();
    expect(normalizeUsage({ usage: { input: 3, output: 1 } }))
      .toEqual({ input: 3, output: 1, totalTokens: 4, costUsd: 0 });
  });
});

describe("record ring", () => {
  async function record(prompt: string) {
    return runOneShot(
      { prompt, provider: "ollama", origin },
      { complete: async () => ({ content: [{ type: "text", text: prompt.toUpperCase() }], stopReason: "stop" }) },
    );
  }

  test("lists newest first", async () => {
    await record("one");
    await record("two");
    expect(listOneShotRecords().map((r) => r.prompt)).toEqual(["two", "one"]);
  });

  test("evicts the oldest past the limit rather than growing forever", async () => {
    for (let i = 0; i < ONE_SHOT_STORE_LIMIT + 5; i++) await record(`p${i}`);
    const all = listOneShotRecords(1000);
    expect(all).toHaveLength(ONE_SHOT_STORE_LIMIT);
    expect(all.at(-1)?.prompt).toBe("p5");
    expect(all[0]?.prompt).toBe(`p${ONE_SHOT_STORE_LIMIT + 4}`);
  });

  test("promotion is recorded on the record", async () => {
    const result = await record("hello");
    recordOneShotPromotion(result.oneShotId, "ses-new");
    expect(getOneShotRecord(result.oneShotId)?.promotedSessionId).toBe("ses-new");
  });
});

describe("promotion prompt", () => {
  const base: OneShotRecord = {
    id: "os-1",
    createdAt: 0,
    profile: "cleanup",
    provider: "ollama",
    model: "qwen",
    prompt: "punctuate: hello there",
    text: "Hello there.",
    origin: { kind: "move", name: "t", cwd: "/proj" },
  };

  test("replays both sides of the exchange", () => {
    const text = buildPromotionPrompt(base);
    expect(text).toContain("punctuate: hello there");
    expect(text).toContain("Hello there.");
    expect(text).toContain("ollama/qwen");
  });

  test("includes the original system instructions when there were any", () => {
    expect(buildPromotionPrompt({ ...base, system: "be terse" })).toContain("be terse");
    expect(buildPromotionPrompt(base)).not.toContain("Original instructions");
  });

  test("an empty answer is labelled rather than left blank", () => {
    expect(buildPromotionPrompt({ ...base, text: "" })).toContain("(empty)");
  });
});
