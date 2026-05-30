/**
 * Gemini CLI capabilities — split into a sibling file with no runtime imports
 * from `@google/gemini-cli-core`. Importing the main `gemini-cli.ts` triggers
 * the SDK's "Experiments loaded" network call to Google's experiment service.
 * Capability listing (UI profile pickers, /api/provider-capabilities, health
 * checks) must NOT pay that cost.
 */

import type { ProviderCapabilities } from "./types";

export const GEMINI_TOOL_GROUPS = [
  { label: "files", tools: ["list_directory", "write_file"] },
  { label: "search", tools: ["grep_search"] },
  { label: "web", tools: ["google_web_search"] },
] as const;

export const GEMINI_CAPABILITIES: ProviderCapabilities = {
  name: "gemini-cli",
  label: "Gemini CLI",
  family: "gemini-cli",
  builtInTools: GEMINI_TOOL_GROUPS.flatMap((group) => group.tools),
  builtInToolGroups: GEMINI_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "explicit",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["thinking", "streaming"],
  permissionModel: {
    mode: "runtime-native",
    interactive: false,
    summary: "Gemini runtime owns approval policy at execution time. This harness path can choose approval mode, but it does not receive live per-tool approval hooks.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
