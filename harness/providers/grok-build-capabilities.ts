import type { ProviderCapabilities } from "./types";

export const GROK_BUILD_TOOL_GROUPS = [
  { label: "files", tools: ["read_file", "write_file", "search_replace", "list_dir"] },
  { label: "search", tools: ["grep", "grep_search"] },
  { label: "exec", tools: ["run_terminal_cmd", "run_terminal_command"] },
  { label: "web", tools: [
    "web_search", "web_fetch", "open_page", "open_page_with_find",
    "x_search", "x_keyword_search", "x_semantic_search", "x_user_search", "x_thread_fetch",
  ] },
  { label: "images", tools: ["image_gen", "image_edit", "image_to_video", "reference_to_video"] },
  { label: "agents", tools: ["task", "spawn_subagent"] },
  { label: "tasks", tools: ["todo_write"] },
  { label: "schedule", tools: ["scheduler_create", "scheduler_list", "scheduler_delete", "monitor"] },
  { label: "interaction", tools: ["ask_user_question", "enter_plan_mode", "exit_plan_mode"] },
] as const;

export const GROK_BUILD_CAPABILITIES: ProviderCapabilities = {
  name: "grok-build",
  label: "Grok Build",
  family: "grok-build",
  builtInTools: GROK_BUILD_TOOL_GROUPS.flatMap((group) => group.tools),
  builtInToolGroups: GROK_BUILD_TOOL_GROUPS.map((group) => ({ label: group.label, tools: [...group.tools] })),
  builtInToolMode: "event-derived",
  slashCommands: [
    { command: "/plan", label: "Plan", description: "Enter or leave plan mode" },
    { command: "/compact", label: "Compact", description: "Compact the current context" },
    { command: "/rewind", label: "Rewind", description: "Rewind the Grok session" },
    { command: "/model", label: "Model", description: "Choose a Grok model" },
    { command: "/effort", label: "Effort", description: "Choose a reasoning effort" },
  ],
  supportsMcp: true,
  mcpSupport: "full",
  profilePrompt: {
    supportedModes: ["append", "custom"],
    delivery: { append: "system", custom: "system" },
    summary: "Grok Build supports appended rules and replacement system prompts.",
  },
  projectInstructions: {
    control: "always",
    sources: "AGENTS.md files",
    summary: "Grok Build always discovers project instructions; its CLI has no disable switch.",
  },
  nonToolSignals: ["thinking", "plan", "streaming"],
  permissionModel: {
    mode: "per-tool-ui",
    interactive: true,
    summary: "Grok Build asks Modus to approve tool calls through ACP. Session-scoped approvals are forwarded when Grok offers them.",
  },
  sessionMutability: {
    providerSwitchAfterStart: false,
    profileSwitch: "provider-locked",
    configApplies: "next-turn",
  },
};
