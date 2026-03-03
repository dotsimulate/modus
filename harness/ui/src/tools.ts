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
  // inherit — check profile
  return profileTools === "all" || profileTools.includes(tool);
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
