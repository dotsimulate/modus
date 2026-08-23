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
  profilePrompt: {
    supportedModes: ["append", "custom"],
    delivery: { append: "system", custom: "system" },
    summary: "OpenCode supports appended instructions and custom primary-agent system prompts.",
  },
  projectInstructions: {
    control: "toggle",
    sources: "OpenCode project config and instruction files",
    summary: "Modus can enable or disable OpenCode project configuration and instructions.",
  },
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
