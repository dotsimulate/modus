/**
 * Tool restrictions for providers whose tools Modus gates itself, by answering
 * the provider's own permission requests (the ACP-style backends: Antigravity,
 * Grok Build, Muse Code).
 *
 * Profiles name tools in Modus's shared vocabulary, the Claude Code names
 * (`Read`, `Bash`, `WebSearch`, ...), because that is what the profile editor and
 * the starter content write. A provider with its own tool names maps that
 * vocabulary through `ProviderCapabilities.toolAliases`; its native names are
 * accepted too. Without the mapping a profile written for Claude would deny every
 * tool on another provider, and a provider that receives a bare rejection tells
 * the model only that the call failed.
 *
 * Semantics match the Claude Code provider:
 * - `tools` is an allowlist of built-in tools. MCP tools are not restricted by it
 *   (Claude turns the allowlist into a built-in blocklist when MCP is present).
 * - `disallowedTools` and `toolStates: off` deny, by any spelling.
 * - `toolStates: on` re-enables a tool the allowlist leaves out, as the tool grid
 *   shows it.
 */

import type { PermissionPolicy } from "../permission-policy";
import { permissionPolicyNeedsApproval } from "../permission-policy";
import type { ActiveSession } from "../session-manager";
import type { ProviderCapabilities, TurnContext } from "./types";

/** Modus/Claude tool name → this provider's native tool names. */
export type ToolAliases = Readonly<Record<string, readonly string[]>>;

export type ToolRestrictionConfig = {
  tools?: string[];
  disallowedTools: string[];
  toolStates: Record<string, string>;
  policy: PermissionPolicy;
};

export type ToolRestriction =
  | { kind: "allowlist"; allowed: string[] }
  | { kind: "disallowed"; entry: string }
  | { kind: "toggled-off"; entry: string };

export type ToolDecision =
  | { decision: "allow" | "ask" }
  | { decision: "deny"; restriction: ToolRestriction };

/** Session overrides win over the turn's options, which win over the profile. */
export function toolRestrictionConfig(ctx: TurnContext): ToolRestrictionConfig {
  const overrides = ctx.session._configOverrides;
  return {
    tools: overrides.tools ?? ctx.opts.tools ?? ctx.profile?.tools,
    disallowedTools: [
      ...(ctx.profile?.disallowedTools ?? []),
      ...(ctx.opts.disallowedTools ?? []),
      ...(overrides.disallowedTools ?? []),
    ],
    toolStates: overrides.toolStates ?? ctx.opts.toolStates ?? {},
    policy: overrides.permissionPolicy ?? ctx.opts.permissionPolicy ?? ctx.profile?.permissionPolicy ?? "bypass",
  };
}

/** MCP tools as each family spells them, plus the collapsed Modus move tool. */
export function isMcpToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("mcp_") || lower === "modus_submit";
}

/**
 * Claude spells MCP tools `mcp__server__tool` and a whole server `mcp__server`;
 * single-underscore families spell them `mcp_server_tool`.
 */
function mcpEntryMatches(entry: string, toolName: string): boolean {
  const lowerEntry = entry.toLowerCase();
  const lowerTool = toolName.toLowerCase();
  if (lowerEntry === lowerTool) return true;
  if (!lowerEntry.startsWith("mcp__")) return false;
  const parts = lowerEntry.slice("mcp__".length).split("__").filter(Boolean);
  if (parts.length === 0) return false;
  const single = `mcp_${parts.join("_")}`;
  if (parts.length === 1) return lowerTool === single || lowerTool.startsWith(`${single}_`) || lowerTool.startsWith(`mcp__${parts[0]}__`);
  return lowerTool === single;
}

/** Whether a configured entry (shared or native name) names this tool. */
export function toolEntryMatches(entry: string, toolName: string, aliases: ToolAliases | undefined): boolean {
  const lowerTool = toolName.toLowerCase();
  if (entry.toLowerCase() === lowerTool) return true;
  if (isMcpToolName(toolName)) return mcpEntryMatches(entry, toolName);
  for (const [shared, natives] of Object.entries(aliases ?? {})) {
    if (shared.toLowerCase() !== entry.toLowerCase()) continue;
    if (natives.some((native) => native.toLowerCase() === lowerTool)) return true;
  }
  return false;
}

/** Shared names that cover a native tool, for messages that tell the user what to add. */
export function sharedNamesFor(toolName: string, aliases: ToolAliases | undefined): string[] {
  const lowerTool = toolName.toLowerCase();
  return Object.entries(aliases ?? {})
    .filter(([, natives]) => natives.some((native) => native.toLowerCase() === lowerTool))
    .map(([shared]) => shared);
}

/**
 * The session toggle that applies to this tool. A toggle on the tool's own name
 * wins (it is what the tool grid writes when a pill is clicked); otherwise a
 * toggle on a shared name that covers it, with `off` beating `on`.
 */
export function toolToggleFor(
  toolName: string,
  toolStates: Record<string, string>,
  aliases: ToolAliases | undefined,
): { state: "on" | "off"; entry: string } | null {
  const set = Object.entries(toolStates).filter((entry): entry is [string, "on" | "off"] => entry[1] === "on" || entry[1] === "off");
  const exact = set.find(([entry]) => entry.toLowerCase() === toolName.toLowerCase());
  if (exact) return { state: exact[1], entry: exact[0] };
  const covering = set.filter(([entry]) => toolEntryMatches(entry, toolName, aliases));
  const chosen = covering.find(([, state]) => state === "off") ?? covering[0];
  return chosen ? { state: chosen[1], entry: chosen[0] } : null;
}

/** The restriction that blocks this tool, or null when none does. */
export function toolRestriction(
  toolName: string,
  config: ToolRestrictionConfig,
  aliases: ToolAliases | undefined,
): ToolRestriction | null {
  const matches = (entry: string) => toolEntryMatches(entry, toolName, aliases);
  const toggle = toolToggleFor(toolName, config.toolStates, aliases);
  if (toggle?.state === "off") return { kind: "toggled-off", entry: toggle.entry };
  const disallowed = config.disallowedTools.find(matches);
  if (disallowed) return { kind: "disallowed", entry: disallowed };
  if (config.tools?.length && !isMcpToolName(toolName) && toggle?.state !== "on" && !config.tools.some(matches)) {
    return { kind: "allowlist", allowed: config.tools };
  }
  return null;
}

/** `autoApprove`/`requireApproval` entries may also use shared names. */
function needsApproval(
  policy: PermissionPolicy,
  toolName: string,
  shellTools: ReadonlySet<string>,
  aliases: ToolAliases | undefined,
): boolean {
  if (typeof policy === "string") return permissionPolicyNeedsApproval(policy, toolName, shellTools);
  const names = (entries?: string[]) => entries?.some((entry) => toolEntryMatches(entry, toolName, aliases)) ? [toolName] : [];
  return permissionPolicyNeedsApproval({
    default: policy.default,
    requireApproval: names(policy.requireApproval),
    autoApprove: names(policy.autoApprove),
  }, toolName, shellTools);
}

export function decideTool(
  session: ActiveSession,
  toolName: string,
  config: ToolRestrictionConfig,
  options: { aliases: ToolAliases | undefined; shellTools: ReadonlySet<string> },
): ToolDecision {
  const restriction = toolRestriction(toolName, config, options.aliases);
  if (restriction) return { decision: "deny", restriction };
  if (session.sessionApprovals.has(toolName)) return { decision: "allow" };
  return { decision: needsApproval(config.policy, toolName, options.shellTools, options.aliases) ? "ask" : "allow" };
}

function listPreview(names: string[]): string {
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? `${shown}, …` : shown;
}

/** One sentence naming the tool, the setting that blocked it, and what would allow it. */
export function describeToolRestriction(
  toolName: string,
  restriction: ToolRestriction,
  aliases: ToolAliases | undefined,
): string {
  const shared = sharedNamesFor(toolName, aliases);
  const allowWith = shared.length ? `${shared.join(" or ")} (or \`${toolName}\`)` : `\`${toolName}\``;
  switch (restriction.kind) {
    case "allowlist":
      return `Modus blocked \`${toolName}\`: this session's tools list (${listPreview(restriction.allowed)}) does not include it. `
        + `Add ${allowWith} to the profile's tools, or switch it on in the session's tool settings.`;
    case "disallowed":
      return `Modus blocked \`${toolName}\`: \`${restriction.entry}\` is in disallowedTools.`;
    case "toggled-off":
      return `Modus blocked \`${toolName}\`: \`${restriction.entry}\` is switched off in this session's tool settings.`;
  }
}

/** A transcript line the user sees; the reducer renders `provider_message` as a system row. */
export function emitProviderNotice(ctx: TurnContext, content: string, severity: "info" | "warning" = "warning"): void {
  const text = content.trim();
  if (!text) return;
  ctx.emitEvent({
    type: "system",
    subtype: "provider_message",
    severity,
    content: severity === "info" ? text : `${severity}: ${text}`,
  });
}

/** Explain a Modus-side denial once per tool and restriction within a turn. */
export function noticeToolDenied(
  ctx: TurnContext,
  noticed: Set<string>,
  toolName: string,
  restriction: ToolRestriction,
  capabilities: Pick<ProviderCapabilities, "toolAliases">,
): void {
  const key = `${toolName.toLowerCase()}:${restriction.kind}`;
  if (noticed.has(key)) return;
  noticed.add(key);
  emitProviderNotice(ctx, describeToolRestriction(toolName, restriction, capabilities.toolAliases));
}
