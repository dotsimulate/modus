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

/**
 * The shared Modus/Claude tool names a profile writes, onto Antigravity's tools.
 * `agy` has no separate search or listing tools (`run_command` does that work),
 * so `Glob` and `Grep` have no counterpart. `manage_task` manages the background
 * commands `run_command` starts, so it travels with the shell tools.
 */
export const ANTIGRAVITY_TOOL_ALIASES: Record<string, string[]> = {
  Bash: ["run_command", "manage_task"],
  PowerShell: ["run_command", "manage_task"],
  Read: ["read_file"],
  Write: ["write_file"],
  Edit: ["edit_file"],
  MultiEdit: ["edit_file"],
  NotebookEdit: ["edit_file"],
  WebSearch: ["search_web"],
  WebFetch: ["search_web"],
  Agent: ["invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm"],
  CronCreate: ["schedule"],
  CronDelete: ["schedule"],
  CronList: ["schedule"],
  ScheduleWakeup: ["schedule"],
  ListMcpResourcesTool: ["list_resources"],
  ReadMcpResourceTool: ["read_resource"],
  AskUserQuestion: ["ask_question"],
};

/**
 * Commands `agy acp` advertises in `available_commands_update` (agy 1.5). A prompt
 * that starts with one is handled by Antigravity itself. Installed skills are
 * advertised the same way and also work when typed; they are not listed here
 * because they differ per machine.
 */
export const ANTIGRAVITY_SLASH_COMMANDS: NonNullable<ProviderCapabilities["slashCommands"]> = [
  { command: "/goal", label: "Goal", description: "Run until the specified goal is completely finished", argumentHint: "<goal>", requiresArgument: true },
  { command: "/compact", label: "Compact", description: "Summarize history to free up the context window" },
  { command: "/plan", label: "Plan", description: "Plan carefully before executing a task" },
  { command: "/schedule", label: "Schedule", description: "Run an instruction on a recurring schedule or as a one-time timer", argumentHint: "<instruction>" },
  { command: "/browser", label: "Browser", description: "Invoke a browser agent for web tasks", argumentHint: "<task>" },
  { command: "/grill-me", label: "Grill me", description: "Interview me to align on a plan" },
  { command: "/teamwork", label: "Teamwork", description: "Invoke a team of agents to tackle a large project", argumentHint: "<project>" },
  { command: "/learn", label: "Learn", description: "Capture reusable skills or rules from recent work" },
  { command: "/boost", label: "Boost", description: "Invoke the Boost multi-agent orchestrator for complex tasks", argumentHint: "<task>" },
  { command: "/swarm", label: "Swarm", description: "Several agents in parallel on one task (preview, quota heavy)", argumentHint: "<task>" },
];

export const ANTIGRAVITY_CAPABILITIES: ProviderCapabilities = {
  name: "antigravity",
  label: "Google Antigravity",
  family: "antigravity",
  builtInTools: ANTIGRAVITY_TOOL_GROUPS.flatMap((group) => [...group.tools]),
  builtInToolGroups: ANTIGRAVITY_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "event-derived",
  toolAliases: ANTIGRAVITY_TOOL_ALIASES,
  slashCommands: ANTIGRAVITY_SLASH_COMMANDS,
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
    summary: "Antigravity asks Modus before commands and file edits in its default mode, before commands only in accept-edits, and only before risky commands in auto; "
      + "Modus answers from the profile's tools and permission policy or a live prompt. Reads, web search, and MCP calls never ask, so Modus reports a restricted one that runs instead of blocking it.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
