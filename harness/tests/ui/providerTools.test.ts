import { describe, expect, test } from "bun:test";
import type { ProviderCapabilities } from "../../sdk/index";
import {
  effectiveToolState,
  getToolGroups,
  isToolEnabled,
  providerDisplayLabel,
  providerToolFamily,
} from "../../ui/src/tools";
import {
  toolEditHunks,
  toolFamily,
  toolInputCommand,
  toolInputPath,
  toolWriteContent,
} from "../../ui/src/tool-names";
import {
  formatProviderTokenUsage,
  formatSidebarProviderStat,
} from "../../ui/src/components/providerStats";

const declarativeCapabilities: ProviderCapabilities = {
  name: "lmstudio",
  label: "LM Studio (local)",
  family: "pi-agent",
  builtInTools: ["read", "write", "edit", "grep", "find", "ls", "bash"],
  builtInToolGroups: [
    { label: "files", tools: ["read", "write", "edit"] },
    { label: "search", tools: ["grep", "find", "ls"] },
    { label: "exec", tools: ["bash"] },
  ],
  builtInToolMode: "explicit",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["streaming"],
  permissionModel: {
    mode: "none",
    interactive: false,
    summary: "PI",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};

describe("provider tool families", () => {
  test("an unknown provider never fails open to Claude's PascalCase tools", () => {
    expect(providerToolFamily("future-provider")).toBe("unknown");
    expect(getToolGroups("future-provider")).toEqual([]);
    expect(getToolGroups("future-provider").flatMap((group) => group.tools)).not.toContain("Bash");
  });

  test("backend capabilities classify a declarative PI provider", () => {
    expect(providerToolFamily("lmstudio", declarativeCapabilities)).toBe("pi-agent");
    expect(getToolGroups("lmstudio", declarativeCapabilities))
      .toEqual(declarativeCapabilities.builtInToolGroups);
    expect(getToolGroups("lmstudio", declarativeCapabilities).flatMap((group) => group.tools))
      .toContain("bash");
    expect(getToolGroups("lmstudio", declarativeCapabilities).flatMap((group) => group.tools))
      .not.toContain("Bash");
  });

  test("provider pickers use the backend label without changing the stored name", () => {
    expect(providerDisplayLabel("lmstudio", declarativeCapabilities)).toBe("LM Studio (local)");
    expect(providerDisplayLabel("unknown")).toBe("unknown");
  });
});

describe("provider usage display", () => {
  test("shows tokens for any provider that reports them, including declarative PI", () => {
    expect(formatProviderTokenUsage("lmstudio", 1200, 300)).toBe("1.5k tok");
    expect(formatSidebarProviderStat("lmstudio", {
      inputTokens: 1200,
      outputTokens: 300,
    })).toBe("1.5k tok");
  });
});

describe("tool names across providers", () => {
  // The map Antigravity's capabilities publish (providers/antigravity-capabilities.ts).
  const antigravityAliases = { Bash: ["run_command", "manage_task"], Read: ["read_file"], Write: ["write_file"] };

  test("a Claude-authored tools list enables the Antigravity tools it names", () => {
    const profileTools = ["Read", "Bash"];
    expect(isToolEnabled("run_command", "inherit", profileTools, antigravityAliases)).toBe(true);
    expect(isToolEnabled("read_file", "inherit", profileTools, antigravityAliases)).toBe(true);
    expect(isToolEnabled("write_file", "inherit", profileTools, antigravityAliases)).toBe(false);
    expect(isToolEnabled("run_command", "inherit", ["bash"], antigravityAliases)).toBe(true);
    // Without the provider's map the list cannot speak for its tools.
    expect(isToolEnabled("run_command", "inherit", profileTools)).toBe(false);
  });

  test("a toggle on the tool's own name wins over one on a shared name", () => {
    expect(effectiveToolState("run_command", { Bash: "off" }, antigravityAliases)).toBe("off");
    expect(effectiveToolState("run_command", { Bash: "off", run_command: "on" }, antigravityAliases)).toBe("on");
    expect(effectiveToolState("run_command", { Bash: "on", PowerShell: "off" }, { ...antigravityAliases, PowerShell: ["run_command"] })).toBe("off");
    expect(effectiveToolState("read_file", { Bash: "off" }, antigravityAliases)).toBe("inherit");
  });

  test("Antigravity's tools and PascalCase arguments get the shell, edit, and web cards", () => {
    expect(toolFamily("run_command")).toBe("shell");
    expect(toolFamily("edit_file")).toBe("edit");
    expect(toolFamily("search_web")).toBe("web");
    expect(toolInputCommand({ CommandLine: "cmd /c echo hi" })).toBe("cmd /c echo hi");
    expect(toolInputPath({ Path: "D:/a.txt" })).toBe("D:/a.txt");
    expect(toolInputPath({ TargetFile: "D:/b.txt" })).toBe("D:/b.txt");
    expect(toolWriteContent({ Content: "hydrogen" })).toBe("hydrogen");
  });

  test("edit hunks come from every provider's edit shape", () => {
    expect(toolEditHunks({ old_string: "a", new_string: "b" })).toEqual([{ oldString: "a", newString: "b" }]);
    expect(toolEditHunks({ edits: [{ old_string: "a", new_string: "b" }, { new_string: "c" }] }))
      .toEqual([{ oldString: "a", newString: "b" }, { oldString: "", newString: "c" }]);
    expect(toolEditHunks({ ReplacementChunks: [{ TargetContent: "x", ReplacementContent: "y" }] }))
      .toEqual([{ oldString: "x", newString: "y" }]);
    expect(toolEditHunks({ Path: "a.ts", Target: "old line", Replacement: "new line" }))
      .toEqual([{ oldString: "old line", newString: "new line" }]);
    expect(toolEditHunks({ Path: "a.txt" })).toEqual([]);
  });
});
