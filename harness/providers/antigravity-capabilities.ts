import type { ProviderCapabilities } from "./types";

/**
 * Tool names as Antigravity's ACP server reports them in `tool_call` updates
 * (agy 1.5). MCP tools arrive as `mcp_<server>_<tool>`. The list is a display
 * aid only: the mode is event-derived, so tools added by later agy releases
 * still render and still go through Modus approval.
 */
export const ANTIGRAVITY_TOOL_GROUPS = [
  { label: "files", tools: ["read_file", "write_file", "edit_file"] },
  { label: "exec", tools: ["run_command", "manage_task", "schedule"] },
  { label: "web", tools: ["search_web"] },
  { label: "agents", tools: ["invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm"] },
  { label: "resources", tools: ["list_resources", "read_resource"] },
  { label: "interaction", tools: ["ask_question"] },
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
  profilePrompt: {
    supportedModes: ["append"],
    delivery: { append: "system" },
    summary: "Antigravity appends the profile prompt to its own system prompt through ACP session metadata; it has no replacement channel.",
  },
  projectInstructions: {
    control: "always",
    sources: "Antigravity rules and project instructions",
    summary: "Antigravity always loads its own rules and project instructions; ACP has no switch to disable them.",
  },
  nonToolSignals: ["thinking", "plan", "streaming"],
  permissionModel: {
    mode: "per-tool-ui",
    interactive: true,
    summary: "Antigravity asks Modus to approve edits and commands through ACP; Modus answers from the profile permission policy or a live prompt.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
