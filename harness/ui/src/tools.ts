/**
 * Claude Code tool definitions — canonical list with grouping.
 * Used by ToolGrid for display and by config components for validation.
 */

export type ToolGroup = {
  label: string;
  tools: string[];
};

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
