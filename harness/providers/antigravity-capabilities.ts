import type { ProviderCapabilities } from "./types";

/**
 * Antigravity tool names come from Google's documented JSON Hooks contract.
 * They are observable at runtime through PreToolUse/PostToolUse hooks.
 */
export const ANTIGRAVITY_TOOL_GROUPS = [
  {
    label: "files",
    tools: ["view_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "list_dir", "find_by_name"],
  },
  { label: "search", tools: ["grep_search", "search_web", "read_url_content"] },
  { label: "exec", tools: ["run_command", "manage_task", "schedule", "list_permissions", "ask_permission"] },
  { label: "agent", tools: ["invoke_subagent", "define_subagent", "send_message", "manage_subagents"] },
  { label: "interaction", tools: ["generate_image"] },
] as const;

export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = {
  name: "antigravity",
  label: "Google Antigravity",
  family: "antigravity",
  builtInTools: ANTIGRAVITY_TOOL_GROUPS.flatMap((group) => [...group.tools]),
  builtInToolGroups: ANTIGRAVITY_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "event-derived",
  supportsMcp: true,
  mcpSupport: "full",
  nonToolSignals: ["tool_lifecycle", "final_response"],
  permissionModel: {
    mode: "per-tool-ui",
    interactive: true,
    summary: "Modus maps Antigravity's documented PreToolUse hook decisions to live approve/deny prompts. Antigravity remains the enforcement point.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
