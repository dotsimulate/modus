import type { ProviderCapabilities } from "./types";

/**
 * Tool names Muse Code reports on `toolCall` items. MSP publishes no tool
 * catalog, so this lists the names its protocol transcripts use; any other
 * tool still renders, because the mode is event-derived.
 */
export const MUSE_CODE_TOOL_GROUPS = [
  { label: "files", tools: ["read_file", "write_file"] },
  { label: "exec", tools: ["shell"] },
] as const;

export const MUSE_CODE_CAPABILITIES: ProviderCapabilities = {
  name: "muse-code",
  label: "Muse Code",
  family: "muse-code",
  builtInTools: MUSE_CODE_TOOL_GROUPS.flatMap((group) => group.tools),
  builtInToolGroups: MUSE_CODE_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "event-derived",
  supportsMcp: true,
  mcpSupport: "full",
  profilePrompt: {
    supportedModes: [],
    delivery: {},
    summary: "The Muse Session Protocol has no system-prompt channel, so Modus cannot deliver profile prompts to Muse Code.",
  },
  projectInstructions: {
    control: "always",
    sources: "Muse Code project configuration",
    summary: "Muse Code owns project instruction discovery; MSP exposes no switch to disable it.",
  },
  nonToolSignals: ["thinking", "streaming"],
  permissionModel: {
    mode: "per-tool-ui",
    interactive: true,
    summary: "Muse Code asks Modus to approve unmatched tool calls over MSP. Session-scoped approvals are forwarded when Muse offers them.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
