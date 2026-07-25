/**
 * Tool definitions — canonical lists with grouping per provider.
 * Used by ToolGrid for display and by config components for validation.
 */

export type ToolGroup = {
  label: string;
  tools: string[];
};

// Claude Code tools (PascalCase — SDK-native names).
// Fallback list mirroring the backend catalog (harness/providers/tool-catalog.ts).
// The live UI prefers the backend's builtInToolGroups (provider capabilities);
// this is used for session seeding, the profile editor, and as an offline default.
export const TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["Read", "Write", "Edit", "NotebookEdit"] },
  { label: "search", tools: ["Glob", "Grep", "LSP"] },
  { label: "exec", tools: ["Bash", "PowerShell"] },
  { label: "web", tools: ["WebSearch", "WebFetch"] },
  { label: "agent", tools: ["Agent", "Skill", "Workflow", "ToolSearch"] },
  { label: "tasks", tools: ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskStop", "TodoWrite"] },
  { label: "schedule", tools: ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor", "RemoteTrigger", "PushNotification"] },
  { label: "plan", tools: ["EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree"] },
  { label: "mcp", tools: ["ListMcpResourcesTool", "ReadMcpResourceTool", "WaitForMcpServers"] },
  { label: "other", tools: ["AskUserQuestion"] },
];

// PI Agent tools (lowercase — pi-coding-agent names)
export const PI_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["read", "write", "edit"] },
  { label: "search", tools: ["grep", "find", "ls"] },
  { label: "exec", tools: ["bash"] },
];

// Codex built-ins are governed by sandbox mode, not per-tool toggles — surfaced
// read-only. Names match Codex's own tool identifiers (see tool-catalog.ts).
export const CODEX_TOOL_GROUPS: ToolGroup[] = [
  { label: "exec", tools: ["shell"] },
  { label: "files", tools: ["apply_patch"] },
  { label: "plan", tools: ["update_plan"] },
  { label: "web", tools: ["web_search"] },
  { label: "image", tools: ["view_image"] },
];

// Conservative Gemini list based on live harness verification.
export const GEMINI_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["list_directory", "write_file"] },
  { label: "search", tools: ["grep_search"] },
  { label: "web", tools: ["google_web_search"] },
];

// Google Antigravity tool identifiers from its documented JSON Hooks contract.
export const ANTIGRAVITY_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["view_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "list_dir", "find_by_name"] },
  { label: "search", tools: ["grep_search", "search_web", "read_url_content"] },
  { label: "exec", tools: ["run_command", "manage_task", "schedule", "list_permissions", "ask_permission"] },
  { label: "agent", tools: ["invoke_subagent", "define_subagent", "send_message", "manage_subagents"] },
  { label: "interaction", tools: ["generate_image"] },
];

// Cursor Agent tools (matches cursor.ts builtInToolGroups)
export const CURSOR_TOOL_GROUPS: ToolGroup[] = [
  { label: "exec", tools: ["Bash"] },
  { label: "files", tools: ["Read", "Edit", "Grep", "Glob"] },
  { label: "web", tools: ["WebSearch"] },
];

export const GROK_BUILD_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["read_file", "write_file", "search_replace", "list_dir"] },
  { label: "search", tools: ["grep_search"] },
  { label: "exec", tools: ["run_terminal_cmd"] },
  { label: "web", tools: ["web_search", "x_search"] },
  { label: "agents", tools: ["task", "spawn_subagent"] },
  { label: "interaction", tools: ["ask_user_question"] },
];

// PI Agent providers use lowercase tool names (read, write, edit, bash, ...)
// Claude Code and Codex both use PascalCase tool names (Read, Write, Edit, Bash, ...)
const PI_PROVIDER_NAMES = new Set(["anthropic", "openai", "litellm", "ollama", "openrouter"]);

export function isPiProvider(provider?: string): boolean {
  return !!provider && PI_PROVIDER_NAMES.has(provider);
}

export function isCodexProvider(provider?: string): boolean {
  return provider === "codex";
}

export function isGeminiProvider(provider?: string): boolean {
  return provider === "gemini-cli";
}

export function isAntigravityProvider(provider?: string): boolean {
  return provider === "antigravity";
}

export function isCursorProvider(provider?: string): boolean {
  return provider === "cursor";
}

export function isGrokBuildProvider(provider?: string): boolean {
  return provider === "grok-build";
}

export function isClaudeCodeProvider(provider?: string): boolean {
  return !provider || provider === "claude-code";
}

export function providerToolFamily(provider?: string): "antigravity" | "claude-code" | "codex" | "cursor" | "gemini-cli" | "grok-build" | "pi-agent" {
  if (isPiProvider(provider)) return "pi-agent";
  if (isCodexProvider(provider)) return "codex";
  if (isAntigravityProvider(provider)) return "antigravity";
  if (isGeminiProvider(provider)) return "gemini-cli";
  if (isCursorProvider(provider)) return "cursor";
  if (isGrokBuildProvider(provider)) return "grok-build";
  return "claude-code";
}

export function getToolGroups(provider?: string): ToolGroup[] {
  switch (providerToolFamily(provider)) {
    case "pi-agent":
      return PI_TOOL_GROUPS;
    case "codex":
      return CODEX_TOOL_GROUPS;
    case "gemini-cli":
      return GEMINI_TOOL_GROUPS;
    case "antigravity":
      return ANTIGRAVITY_TOOL_GROUPS;
    case "cursor":
      return CURSOR_TOOL_GROUPS;
    case "grok-build":
      return GROK_BUILD_TOOL_GROUPS;
    default:
      return TOOL_GROUPS;
  }
}

export function getAllTools(provider?: string): string[] {
  return getToolGroups(provider).flatMap((g) => g.tools);
}

export const ALL_TOOLS = TOOL_GROUPS.flatMap((g) => g.tools);

/**
 * Three-state tool toggle:
 * - "inherit" — follows profile default (on or off depending on profile)
 * - "on"      — explicitly enabled (override)
 * - "off"     — explicitly disabled (override)
 */
export type ToolState = "inherit" | "on" | "off";

export type ToolStates = Record<string, ToolState>;

/** Is this tool enabled given its state and the profile baseline? */
export function isToolEnabled(
  tool: string,
  state: ToolState,
  profileTools: string[] | "all",
): boolean {
  if (state === "on") return true;
  if (state === "off") return false;
  // inherit — MCP tools default to enabled (backend uses disallowedTools blocklist)
  if (tool.startsWith("mcp__")) return true;
  // inherit — check profile for built-in tools
  return profileTools === "all" || profileTools.includes(tool);
}

/** Parse MCP tool names into ToolGroups by server name.
 * MCP tools follow the naming convention: mcp__<server-name>__<tool-name>
 */
export function mcpToolGroups(availableTools: string[]): ToolGroup[] {
  const serverMap = new Map<string, string[]>();
  for (const tool of availableTools) {
    if (!tool.startsWith("mcp__")) continue;
    const parts = tool.split("__");
    if (parts.length < 3) continue;
    const serverName = parts[1];
    if (!serverName) continue;
    const existing = serverMap.get(serverName) ?? [];
    existing.push(tool);
    serverMap.set(serverName, existing);
  }
  return Array.from(serverMap.entries()).map(([server, tools]) => ({
    label: server,
    tools,
  }));
}

/** Strip MCP prefix for display: mcp__server__tool_name → tool_name */
export function mcpToolDisplayName(tool: string): string {
  if (!tool.startsWith("mcp__")) return tool;
  return tool.split("__").slice(2).join("__");
}

/** Convert ToolStates to SDK-compatible tools/disallowedTools arrays */
export function toSdkToolConfig(
  states: ToolStates,
  profileTools: string[] | "all",
): { tools?: string[]; disallowedTools?: string[] } {
  const overrideOn = Object.entries(states)
    .filter(([, s]) => s === "on")
    .map(([t]) => t);
  const overrideOff = Object.entries(states)
    .filter(([, s]) => s === "off")
    .map(([t]) => t);

  // No overrides — let profile handle it
  if (overrideOn.length === 0 && overrideOff.length === 0) {
    return {};
  }

  // If profile is "all", only need disallowedTools for off overrides
  if (profileTools === "all") {
    return overrideOff.length > 0 ? { disallowedTools: overrideOff } : {};
  }

  // Profile has specific tools — compute effective list
  const effective = new Set(profileTools);
  for (const t of overrideOn) effective.add(t);
  for (const t of overrideOff) effective.delete(t);
  return { tools: Array.from(effective) };
}
