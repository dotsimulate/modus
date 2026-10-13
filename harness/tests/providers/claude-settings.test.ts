import { describe, expect, test } from "bun:test";
import {
  applyContextWindowCap,
  claudeFlagSettings,
  pickClaudeAutoCompactWindow,
} from "../../providers/claude-settings";

describe("claude settings", () => {
  test("leaves compaction to Claude Code when no contextWindow is configured", () => {
    expect(pickClaudeAutoCompactWindow(undefined, undefined, "claude-code")).toBeUndefined();
    expect(pickClaudeAutoCompactWindow({}, { "claude-code": {} }, "claude-code")).toBeUndefined();
    expect(claudeFlagSettings(undefined)).toBeUndefined();
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
    expect(claudeFlagSettings(600_000)).toEqual({ autoCompactWindow: 600_000 });
  });

  test("reports the compaction window as the context window", () => {
    const capped: Record<string, any> = { modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } };
    applyContextWindowCap(capped, 600_000);
    expect(capped.context_window).toBe(600_000);

    const smallerModel: Record<string, any> = { modelUsage: { "claude-x": { contextWindow: 200_000 } } };
    applyContextWindowCap(smallerModel, 600_000);
    expect(smallerModel.context_window).toBe(200_000);

    const unset: Record<string, any> = { modelUsage: { "claude-opus-5-5": { contextWindow: 1_000_000 } } };
    applyContextWindowCap(unset, undefined);
    expect(unset.context_window).toBeUndefined();
  });
});
