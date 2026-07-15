import { describe, expect, test } from "bun:test";
import { selectProviderResumeTarget } from "./provider-session-identity";

const existing = (...ids: string[]) => (id: string) => ids.includes(id);

describe("provider resume identity", () => {
  test("does not resume a new empty session", () => {
    expect(selectProviderResumeTarget({
      needsResume: false,
      modusSessionId: "modus-id",
      providerLabel: "Claude Code",
    }, existing())).toEqual({ target: null, source: "none" });
  });

  test("uses persisted provider identity instead of the Modus row ID", () => {
    expect(selectProviderResumeTarget({
      needsResume: true,
      modusSessionId: "modus-id",
      persistedProviderSessionId: "claude-id",
      providerLabel: "Claude Code",
    }, existing("modus-id", "claude-id"))).toEqual({ target: "claude-id", source: "persisted" });
  });

  test("recovers a legacy split identity only when native history exists", () => {
    expect(selectProviderResumeTarget({
      needsResume: true,
      modusSessionId: "modus-id",
      observedProviderSessionIds: ["claude-id"],
      providerLabel: "Claude Code",
    }, existing("claude-id"))).toEqual({ target: "claude-id", source: "legacy-observed" });
  });

  test("prefers the original observed provider identity over a later false Modus-native file", () => {
    expect(selectProviderResumeTarget({
      needsResume: true,
      modusSessionId: "modus-id",
      observedProviderSessionIds: ["original-claude-id", "modus-id"],
      providerLabel: "Claude Code",
    }, existing("original-claude-id", "modus-id"))).toEqual({
      target: "original-claude-id",
      source: "legacy-observed",
    });
  });

  test("fails closed when a persisted provider conversation is missing", () => {
    const result = selectProviderResumeTarget({
      needsResume: true,
      modusSessionId: "modus-id",
      persistedProviderSessionId: "missing-claude-id",
      providerLabel: "Claude Code",
    }, existing("modus-id"));
    expect(result.target).toBeNull();
    expect(result.error).toContain("refusing");
  });

  test("never guesses a Modus ID without provider-native history", () => {
    const result = selectProviderResumeTarget({
      needsResume: true,
      modusSessionId: "modus-id",
      providerLabel: "Claude Code",
    }, existing());
    expect(result.target).toBeNull();
    expect(result.error).toContain("no verifiable native conversation");
  });
});
