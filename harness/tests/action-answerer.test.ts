import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  actionAnswerer,
  answerWithCompletion,
  completionActionConfigError,
  completionPrompt,
} from "../action-answerer";
import type { ActionConfig } from "../action-types";

const runnerSource = readFileSync(resolve(import.meta.dir, "../action-runner.ts"), "utf8");

function config(overrides: Partial<ActionConfig> = {}): ActionConfig {
  return {
    name: "auto-title",
    description: "Name a session",
    enabled: true,
    agentProfile: "LOCAL-POOL",
    trigger: { type: "manual" },
    ...overrides,
  };
}

describe("action answerer selection", () => {
  test("absent preserves the historic session answerer", () => {
    expect(actionAnswerer(config())).toBe("session");
    expect(completionActionConfigError(config())).toBeNull();
  });

  test("an unknown authored selector is rejected rather than treated as a session", () => {
    const invalid = { ...config(), answerer: "assistant" } as unknown as ActionConfig;
    expect(completionActionConfigError(invalid)).toBe(
      'action "auto-title" answerer must be "session" or "completion"',
    );
  });

  test("explicit completion rejects every session-only field instead of ignoring it", () => {
    const error = completionActionConfigError(config({
      answerer: "completion",
      steps: [{ profile: "second" }],
      maxTurns: 2,
      tools: ["Read"],
      skills: ["review"],
      moves: [{ name: "watch" }],
    }));
    expect(error).toContain("steps, maxTurns, tools, moves, skills");
  });

  test("completion requires a string because one-shots have no multipart transport", () => {
    expect(() => completionPrompt([
      { type: "text", text: "name this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    ], "auto-title")).toThrow("multipart text/image content requires a session answerer");
  });
});

describe("completion answerer", () => {
  test("the runner uses the gated model namespace and keeps session spawning in the other branch", () => {
    expect(runnerSource).toContain('if (answerer === "completion")');
    expect(runnerSource).toContain("completer: ctx.model");
    expect(runnerSource).not.toMatch(/import[^;]*runOneShot/);
    expect(runnerSource.indexOf('if (answerer === "completion")')).toBeLessThan(
      runnerSource.indexOf("startSession({"),
    );
  });

  test("routes profile plus provider/model overrides through the gated completer and preserves telemetry", async () => {
    let request: Record<string, unknown> | undefined;
    const answer = await answerWithCompletion({
      actionName: "auto-title",
      prompt: "Name this session",
      profile: "project:LOCAL-POOL",
      provider: "litellm",
      model: "ornith",
      completer: {
        async complete(opts) {
          request = opts;
          return {
            text: "Action Answerers",
            oneShotId: "os-1",
            provider: "litellm",
            model: "ornith",
            transport: "in-process",
            elapsedMs: 407,
            stopReason: "stop",
            usage: { input: 18, output: 6, totalTokens: 24, costUsd: 0 },
          };
        },
      },
    });

    expect(request).toEqual({
      prompt: "Name this session",
      profile: "project:LOCAL-POOL",
      provider: "litellm",
      model: "ornith",
    });
    expect(answer).toEqual({
      response: "Action Answerers",
      summary: "Action Answerers",
      costUsd: 0,
      completion: {
        oneShotId: "os-1",
        provider: "litellm",
        model: "ornith",
        transport: "in-process",
        elapsedMs: 407,
        stopReason: "stop",
        usage: { input: 18, output: 6, totalTokens: 24, costUsd: 0 },
      },
    });
  });

  test("a missing or denied completer fails instead of falling back to a session", async () => {
    await expect(answerWithCompletion({
      actionName: "auto-title",
      prompt: "Name this session",
      profile: "LOCAL-POOL",
      completer: {
        async complete() {
          throw new Error("modelCall denied for reviewed action");
        },
      },
    })).rejects.toThrow("modelCall denied");
  });
});
