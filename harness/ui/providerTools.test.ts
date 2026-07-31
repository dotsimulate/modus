import { describe, expect, test } from "bun:test";
import type { ProviderCapabilities } from "../sdk/index";
import {
  getToolGroups,
  providerDisplayLabel,
  providerToolFamily,
} from "./src/tools";
import {
  formatProviderTokenUsage,
  formatSidebarProviderStat,
} from "./src/components/providerStats";

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
