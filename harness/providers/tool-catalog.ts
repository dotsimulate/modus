/**
 * Tool Catalog — canonical built-in tool lists per provider family.
 *
 * Single source of truth for which built-in tools a provider exposes and how
 * they group in the config UI. Provider capabilities import from here so the
 * backend (`builtInTools` / `builtInToolGroups`) and the `/api/provider-capabilities`
 * response the UI consumes never drift from one hand-maintained list.
 *
 * Keep these in sync with the upstream tool references when providers ship new
 * tools:
 *   Claude Code: https://code.claude.com/docs/en/tools-reference
 *   Codex CLI:   https://developers.openai.com/codex/cli/features
 */

export type ToolCatalogGroup = { label: string; tools: string[] };

// ── Claude Code (v2.1+) ──
// Full built-in set, grouped for the config grid. `ALL_BUILTIN` in the
// claude-code providers is derived from this — it is the universe used to
// convert a profile tool allowlist into an SDK disallowedTools blocklist, so it
// MUST list every gate-able built-in or some tools can never be turned off.
export const CLAUDE_CODE_TOOL_GROUPS: ToolCatalogGroup[] = [
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

export const CLAUDE_CODE_BUILTIN_TOOLS: string[] = CLAUDE_CODE_TOOL_GROUPS.flatMap((g) => g.tools);

// ── Codex CLI ──
// Codex governs tools through sandbox modes, not per-tool allow/deny, so these
// are informational (surfaced read-only in the UI). Names match Codex's own
// built-in tool identifiers, not the Claude PascalCase set.
export const CODEX_TOOL_GROUPS: ToolCatalogGroup[] = [
  { label: "exec", tools: ["shell"] },
  { label: "files", tools: ["apply_patch"] },
  { label: "plan", tools: ["update_plan"] },
  { label: "web", tools: ["web_search"] },
  { label: "image", tools: ["view_image"] },
];

export const CODEX_BUILTIN_TOOLS: string[] = CODEX_TOOL_GROUPS.flatMap((g) => g.tools);
