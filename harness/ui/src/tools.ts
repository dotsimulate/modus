/**
 * Tool definitions — canonical lists with grouping per provider.
 * Used by ToolGrid for display and by config components for validation.
 */

export type ToolGroup = {
  label: string;
  tools: string[];
};

// Claude Code tools (PascalCase — SDK-native names)
export const TOOL_GROUPS: ToolGroup[] = [
  {
    label: "files",
    tools: ["Read", "Write", "Edit", "MultiEdit"],
  },
  {
    label: "search",
    tools: ["Glob", "Grep"],
  },
  {
    label: "exec",
    tools: ["Bash"],
  },
  {
    label: "web",
    tools: ["WebSearch", "WebFetch"],
  },
  {
    label: "agent",
    tools: ["Agent", "TodoWrite", "Skill"],
  },
  {
    label: "other",
    tools: ["NotebookEdit", "AskUserQuestion"],
  },
];

// PI Agent tools (lowercase — pi-coding-agent names)
export const PI_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["read", "write", "edit"] },
  { label: "search", tools: ["grep", "find", "ls"] },
  { label: "exec", tools: ["bash"] },
];

export const CODEX_TOOL_GROUPS: ToolGroup[] = [
  { label: "exec", tools: ["Bash"] },
  { label: "files", tools: ["Edit"] },
  { label: "web", tools: ["WebSearch"] },
];

// Conservative Gemini list based on live harness verification.
export const GEMINI_TOOL_GROUPS: ToolGroup[] = [
  { label: "files", tools: ["list_directory", "write_file"] },
  { label: "search", tools: ["grep_search"] },
  { label: "web", tools: ["google_web_search"] },
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

export function isClaudeCodeProvider(provider?: string): boolean {
  return !provider || provider === "claude-code";
}

export function providerToolFamily(provider?: string): "claude-code" | "codex" | "gemini-cli" | "pi-agent" {
  if (isPiProvider(provider)) return "pi-agent";
  if (isCodexProvider(provider)) return "codex";
  if (isGeminiProvider(provider)) return "gemini-cli";
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
