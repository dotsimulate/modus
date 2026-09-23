import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexConfig, buildCodexInput } from "../../providers/codex";
import { buildCursorInput, syncCursorProfilePlugin } from "../../providers/cursor";
import { buildOpenCodeInput, buildOpenCodeProfileLaunch } from "../../providers/opencode";
import { buildGeminiRequest } from "../../providers/gemini-cli-input";
import { buildAntigravityArgs } from "../../providers/antigravity";
import { launchArgs as buildGrokLaunchArgs } from "../../providers/grok-build";
import { piProfileResourceOverrides } from "../../providers/pi-agent";
import { getProviderCapabilities } from "../../providers/registry";
import { removeSensitiveTempDirectory } from "../../sensitive-temp";
import { requireSupportedProfilePrompt } from "../../providers/profile-prompt-delivery";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(mode: "append" | "custom" = "append", loadProjectSettings = true) {
  const cwd = mkdtempSync(join(tmpdir(), "modus-profile-delivery-"));
  tempRoots.push(cwd);
  return {
    profile: {
      description: "test",
      prompt: "Keep answers concise.",
      promptMode: mode,
      loadProjectSettings,
    },
    opts: { cwd, loadProjectSettings },
    session: {
      sessionId: "profile-delivery-test",
      cwd,
      projectRoot: cwd,
      additionalDirectories: [],
      _configOverrides: {},
    },
  } as any;
}

describe("profile prompt delivery", () => {
  test("keeps the outgoing user payload byte-for-byte unchanged", () => {
    const message = "Do this exactly.\n\nNo hidden wrapper.";
    const ctx = context("append");

    expect(buildCodexInput(message, ctx)).toBe(message);
    expect(buildCursorInput(message, ctx)).toBe(message);
    expect(buildOpenCodeInput(message, ctx)).toBe(message);
    expect(buildGeminiRequest(message)).toEqual([{ text: message }]);
    expect(buildAntigravityArgs({ prompt: message })[1]).toBe(message);
  });

  test("uses Codex native instruction config and disables AGENTS discovery when requested", () => {
    const append = buildCodexConfig(context("append", false)).config as any;
    expect(append.developer_instructions).toBe("Keep answers concise.");
    expect(append.instructions).toBeUndefined();
    expect(append.project_doc_max_bytes).toBe(0);

    const custom = buildCodexConfig(context("custom")).config as any;
    expect(custom.instructions).toBe("Keep answers concise.");
    expect(custom.developer_instructions).toBeUndefined();
  });

  test("uses OpenCode config channels instead of adding prompt text to the run argument", () => {
    const appendCtx = context("append", false);
    const append = buildOpenCodeProfileLaunch(appendCtx);
    try {
      const config = JSON.parse(append.env.OPENCODE_CONFIG_CONTENT);
      expect(config.instructions).toHaveLength(1);
      expect(append.agent).toBeUndefined();
      expect(append.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true");
    } finally {
      if (append.sensitiveTempDir) removeSensitiveTempDirectory(append.sensitiveTempDir);
    }

    const custom = buildOpenCodeProfileLaunch(context("custom"));
    try {
      const config = JSON.parse(custom.env.OPENCODE_CONFIG_CONTENT);
      expect(custom.agent).toBe("modus-profile");
      expect(config.agent["modus-profile"].prompt).toContain("{file:");
    } finally {
      if (custom.sensitiveTempDir) removeSensitiveTempDirectory(custom.sensitiveTempDir);
    }
  });

  test("loads Cursor append prompts as private rules and rejects replacement mode", () => {
    const state = { profilePluginDir: null } as any;
    const pluginDir = syncCursorProfilePlugin(context("append"), state);
    try {
      const rule = readFileSync(join(pluginDir!, "rules", "modus-profile.mdc"), "utf8");
      expect(rule).toContain("alwaysApply: true");
      expect(rule).toContain("Keep answers concise.");
    } finally {
      if (state.profilePluginDir) removeSensitiveTempDirectory(state.profilePluginDir);
    }

    expect(() => syncCursorProfilePlugin(context("custom"), { profilePluginDir: null } as any))
      .toThrow("cannot deliver a custom profile prompt");
  });

  test("maps Grok prompt modes to its native prompt flags", () => {
    const appendArgs = buildGrokLaunchArgs(context("append"), {} as any);
    expect(appendArgs.slice(1, 3)).toEqual(["--rules", "Keep answers concise."]);

    const customArgs = buildGrokLaunchArgs(context("custom"), {} as any);
    expect(customArgs.slice(1, 3)).toEqual(["--system-prompt-override", "Keep answers concise."]);
  });

  test("maps PI append/custom modes without inverting them", () => {
    const appendState = { prompt: { text: "Profile", mode: "append" as const }, loadProjectSettings: false };
    const append = piProfileResourceOverrides(appendState, "Extra roots");
    expect(append.systemPromptOverride("PI built-in")).toBe("PI built-in");
    expect(append.appendSystemPromptOverride([])).toEqual(["Profile", "Extra roots"]);
    expect(append.agentsFilesOverride({ agentsFiles: [{ path: "AGENTS.md", content: "project" }] })).toEqual({ agentsFiles: [] });

    const customState = { prompt: { text: "Profile", mode: "custom" as const }, loadProjectSettings: true };
    const custom = piProfileResourceOverrides(customState);
    expect(custom.systemPromptOverride("PI built-in")).toBe("Profile");
    expect(custom.appendSystemPromptOverride([])).toEqual([]);
  });

  test("advertises unsupported modes and project controls per provider", () => {
    const expected = {
      "claude-code": [["append", "custom"], "toggle"],
      "claude-code-pty": [["append", "custom"], "toggle"],
      codex: [["append", "custom"], "toggle"],
      cursor: [["append"], "always"],
      "grok-build": [["append", "custom"], "always"],
      opencode: [["append", "custom"], "toggle"],
    } as const;

    for (const [provider, [modes, control]] of Object.entries(expected)) {
      const capabilities = getProviderCapabilities(provider);
      expect(capabilities.profilePrompt.supportedModes).toEqual(modes);
      expect(capabilities.projectInstructions.control).toBe(control);
    }
  });

  test("rejects unsupported prompt modes instead of fabricating a user-message channel", () => {
    expect(() => requireSupportedProfilePrompt(getProviderCapabilities("cursor"), context("custom").profile)).toThrow("cannot deliver a custom profile prompt");
  });
});
