import { describe, expect, test } from "bun:test";
import {
  applyContextWindowCap,
  compactWindowForModel,
  mergeClaudeCompactSettings,
  pickClaudeAutoCompactWindow,
} from "../../providers/claude-settings";

describe("claude settings", () => {
  test("leaves compaction to Claude Code when no contextWindow is configured", () => {
    expect(pickClaudeAutoCompactWindow(undefined, undefined, "claude-code")).toBeUndefined();
    expect(pickClaudeAutoCompactWindow({}, { "claude-code": {} }, "claude-code")).toBeUndefined();
    expect(mergeClaudeCompactSettings({})).toBeUndefined();
  });

  test("a profile contextWindow wins over provider defaults", () => {
    const defaults = { "claude-code": { contextWindow: 400_000 } };
    expect(pickClaudeAutoCompactWindow({ contextWindow: 600_000 }, defaults, "claude-code")).toBe(600_000);
    expect(pickClaudeAutoCompactWindow(undefined, defaults, "claude-code")).toBe(400_000);
  });

  test("the PTY provider falls back to claude-code provider defaults", () => {
    expect(pickClaudeAutoCompactWindow(undefined, { "claude-code": { contextWindow: 600_000 } }, "claude-code-pty"))
      .toBe(600_000);
    expect(pickClaudeAutoCompactWindow(undefined, {
      "claude-code": { contextWindow: 600_000 },
      "claude-code-pty": { contextWindow: 300_000 },
    }, "claude-code-pty")).toBe(300_000);
  });

  test("clamps to the range Claude Code accepts instead of letting it drop the value", () => {
    expect(pickClaudeAutoCompactWindow({ contextWindow: 65_536 }, undefined, "claude-code")).toBe(100_000);
    expect(pickClaudeAutoCompactWindow({ contextWindow: 2_000_000 }, undefined, "claude-code")).toBe(1_000_000);
  });

  test("carries a per-model /autocompact window from the user settings file", () => {
    const user = { theme: "dark", modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000, effortLevel: "high" } } };
    expect(mergeClaudeCompactSettings({ user })).toEqual({
      modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000 } },
    });
  });

  test("merges settings files the way Claude Code does", () => {
    // Per-model entries accumulate across sources.
    expect(mergeClaudeCompactSettings({
      user: { modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000 } } },
      project: { modelSettings: { "claude-sonnet-5-5": { autoCompactWindow: 400_000 } } },
    })).toEqual({
      modelSettings: {
        "claude-opus-5-5": { autoCompactWindow: 600_000 },
        "claude-sonnet-5-5": { autoCompactWindow: 400_000 },
      },
    });
    // A top-level value in a higher source replaces lower per-model entries.
    expect(mergeClaudeCompactSettings({
      user: { modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000 } } },
      local: { autoCompactWindow: 300_000 },
    })).toEqual({ autoCompactWindow: 300_000 });
    // Values the CLI would reject are ignored, as the CLI ignores them.
    expect(mergeClaudeCompactSettings({ user: { autoCompactWindow: 50_000 } })).toBeUndefined();
  });

  test("looks up the window for the session's model", () => {
    const settings = { autoCompactWindow: 800_000, modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000 } } };
    expect(compactWindowForModel(settings, "claude-opus-5-5")).toBe(600_000);
    expect(compactWindowForModel(settings, "claude-opus-5-5[1m]")).toBe(600_000);
    expect(compactWindowForModel(settings, "claude-sonnet-5-5")).toBe(800_000);
    expect(compactWindowForModel({ modelSettings: settings.modelSettings }, "claude-sonnet-5-5")).toBeUndefined();
  });

  test("reports the compaction window as the context window", () => {
    const capped: Record<string, any> = { modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } };
    applyContextWindowCap(capped, { autoCompactWindow: 600_000 });
    expect(capped.context_window).toBe(600_000);

    const smallerModel: Record<string, any> = { modelUsage: { "claude-x": { contextWindow: 200_000 } } };
    applyContextWindowCap(smallerModel, { autoCompactWindow: 600_000 });
    expect(smallerModel.context_window).toBe(200_000);

    const unset: Record<string, any> = { modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } };
    applyContextWindowCap(unset, undefined);
    expect(unset.context_window).toBeUndefined();

    const perModel: Record<string, any> = { modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } };
    applyContextWindowCap(perModel, { modelSettings: { "claude-opus-5-5": { autoCompactWindow: 600_000 } } });
    expect(perModel.context_window).toBe(600_000);
  });
});
