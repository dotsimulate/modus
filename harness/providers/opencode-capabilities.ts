import type { ProviderCapabilities } from "./types";

export const OPENCODE_TOOL_GROUPS = [
  { label: "exec", tools: ["bash"] },
  { label: "files", tools: ["read", "write", "edit"] },
  { label: "search", tools: ["grep", "glob"] },
] as const;

export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  name: "opencode",
  label: "OpenCode",
  family: "opencode",
  builtInTools: OPENCODE_TOOL_GROUPS.flatMap((group) => group.tools),
  builtInToolGroups: OPENCODE_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "event-derived",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["reasoning", "streaming"],
  permissionModel: {
    mode: "runtime-native",
    interactive: false,
    summary: "OpenCode CLI owns tool permission handling. This harness provider can bypass permissions for trusted profiles, but it does not surface live per-tool approval prompts.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
