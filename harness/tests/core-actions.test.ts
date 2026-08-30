import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import {
  coreActionOverlayPath,
  patchCoreActionOverlay,
  readCoreActionOverlay,
} from "../core-action-overlay";
import { resolveActionSettingReference } from "../action-setting-reference";
import { cleanTitle } from "../core-actions/auto-title/context";
import type { ActionConfig } from "../action-types";

const repoRoot = resolve(import.meta.dir, "..", "..");

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "modus-core-actions-"));
}

describe("core action overlay", () => {
  test("an absent overlay leaves the shipped default alone", () => {
    const home = tempHome();
    try {
      expect(readCoreActionOverlay(home)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a toggle round-trips per Vault without touching the shipped action.json", () => {
    const home = tempHome();
    try {
      patchCoreActionOverlay("auto-title", { enabled: true }, home);
      expect(readCoreActionOverlay(home)["auto-title"]).toEqual({ enabled: true });

      patchCoreActionOverlay("auto-title", { enabled: false }, home);
      expect(readCoreActionOverlay(home)["auto-title"]).toEqual({ enabled: false });

      // The shipped default is untouched: that is the whole point of the overlay.
      const shipped = JSON.parse(
        readFileSync(join(repoRoot, "harness/core-actions/auto-title/action.json"), "utf-8"),
      ) as ActionConfig;
      expect(shipped.enabled).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("two Vaults disagree about the same action", () => {
    const first = tempHome();
    const second = tempHome();
    try {
      patchCoreActionOverlay("auto-title", { enabled: true }, first);
      expect(readCoreActionOverlay(first)["auto-title"]?.enabled).toBe(true);
      expect(readCoreActionOverlay(second)["auto-title"]).toBeUndefined();
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("a corrupt overlay is ignored rather than stopping action loading", () => {
    const home = tempHome();
    try {
      writeFileSync(coreActionOverlayPath(home), "{ not json", "utf-8");
      expect(readCoreActionOverlay(home)).toEqual({});
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("settings references in provider/model", () => {
  const settings = (values: Record<string, unknown>) => ({
    get: <T,>(key: string) => values[key] as T | undefined,
  });

  test("a reference resolves to the configured value", () => {
    expect(resolveActionSettingReference("${settings.titleProvider}", settings({ titleProvider: "openrouter" })))
      .toBe("openrouter");
  });

  test("a literal value is passed through untouched", () => {
    expect(resolveActionSettingReference("openrouter", settings({}))).toBe("openrouter");
    expect(resolveActionSettingReference(undefined, settings({}))).toBeUndefined();
  });

  test("an unresolved reference falls back rather than reaching a provider as literal text", () => {
    const unresolved: string[] = [];
    expect(resolveActionSettingReference("${settings.titleModel}", settings({}), (key) => unresolved.push(key)))
      .toBeUndefined();
    expect(unresolved).toEqual(["titleModel"]);
  });

  test("a blank stored value counts as unset", () => {
    expect(resolveActionSettingReference("${settings.titleModel}", settings({ titleModel: "   " })))
      .toBeUndefined();
  });

  test("interpolation inside a longer string is not a reference", () => {
    // Whole-string only: a partial substitution would produce a model id that
    // looks plausible and fails at the provider.
    expect(resolveActionSettingReference("prefix-${settings.titleModel}", settings({ titleModel: "x" })))
      .toBe("prefix-${settings.titleModel}");
  });
});

describe("auto-title", () => {
  test("ships opt-in, completion-answered, and scoped to the first assistant round", () => {
    const config = JSON.parse(
      readFileSync(join(repoRoot, "harness/core-actions/auto-title/action.json"), "utf-8"),
    ) as ActionConfig;

    expect(config.enabled).toBe(false);
    expect(config.answerer).toBe("completion");
    expect(config.trigger).toEqual({
      type: "session",
      on: { role: "assistant", round: 1, at: "end" },
      excludeTags: ["internal", "auto-titled"],
    });
    // Never re-titles a session it already named, and never fires on the
    // sessions actions spawn — either would cascade.
    expect(config.trigger.type === "session" && config.trigger.excludeTags).toContain("auto-titled");
  });

  test("the shipped agent profile it names exists as a template", () => {
    const profile = JSON.parse(
      readFileSync(join(repoRoot, "harness/templates/profiles/agents/summarizer.json"), "utf-8"),
    ) as { promptMode?: string };
    expect(profile.promptMode).toBe("custom");
  });

  test("titles are stripped of what a model wraps them in", () => {
    expect(cleanTitle('"Refactor the action runner"')).toBe("Refactor the action runner");
    expect(cleanTitle("Title: Debugging CRLF endings")).toBe("Debugging CRLF endings");
    expect(cleanTitle("Naming sessions automatically.")).toBe("Naming sessions automatically");
    expect(cleanTitle("First line only\nand an explanation")).toBe("First line only");
  });

  test("an unusable answer yields null so the existing preview is kept", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("   ")).toBeNull();
    // A model that ignored "3-6 words" and wrote a paragraph.
    expect(cleanTitle("x".repeat(200))).toBeNull();
  });
});
