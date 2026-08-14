import { describe, expect, test } from "bun:test";
import { codexVersionSupportsFeatureFlags } from "../../providers/codex-cli-sdk";

describe("codexVersionSupportsFeatureFlags", () => {
  test("rejects versions that predate feature flags", () => {
    expect(codexVersionSupportsFeatureFlags("codex-cli 0.124.0")).toBe(false);
    expect(codexVersionSupportsFeatureFlags("codex-cli 0.135.9")).toBe(false);
  });

  test("accepts 0.136 and later", () => {
    expect(codexVersionSupportsFeatureFlags("codex-cli 0.136.0")).toBe(true);
    expect(codexVersionSupportsFeatureFlags("codex-cli 0.150.2")).toBe(true);
    expect(codexVersionSupportsFeatureFlags("codex-cli 1.0.0")).toBe(true);
  });

  test("returns null for unrecognizable output", () => {
    expect(codexVersionSupportsFeatureFlags("")).toBeNull();
    expect(codexVersionSupportsFeatureFlags("command not found")).toBeNull();
  });
});
