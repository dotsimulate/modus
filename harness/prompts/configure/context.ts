import type { PromptGatherContext } from "../../gather-types";

export async function gather(ctx: PromptGatherContext): Promise<string> {
  const { mode = "edit", agents, actions, providers, permissions, text } = ctx.inputs as Record<string, string>;

  const modeLines: Record<string, string> = {
    create: "Mode: create new configuration from scratch.",
    edit: "Mode: edit existing configuration.",
    review: "Mode: review only — audit current config and suggest improvements. Do not modify files.",
  };

  const parts = [`Configure ${ctx.project.name}.`];

  if (modeLines[mode]) parts.push("", modeLines[mode]!);

  parts.push("", `Project: ${ctx.project.name}`);
  if (ctx.project.slug) parts.push(`Profile: ${ctx.project.slug}`);
  if (ctx.project.paths.length) parts.push(`Paths: ${ctx.project.paths.join(", ")}`);

  if (text) parts.push("", `Request: ${text}`);

  if (agents === "yes") parts.push("", "Agents — create/edit profiles in .modus/profiles/agents/. Use /create-profile skill for schemas. permissionPolicy: \"bypass\" unless restricted. Prompts: 2-6 sentences, dense.");
  if (actions === "yes") parts.push("Actions — create/edit in .modus/actions/. Use /create-action skill for schemas. Each needs action.json + context.ts.");
  if (providers === "yes") parts.push("Providers — configure in _global.json. Only touch provider fields.");
  if (permissions === "yes") parts.push("Permissions — audit permissionPolicy on agent profiles, review tool access.");

  parts.push("", `Edit existing files, Write only for new ones. Omit defaults.${ctx.project.slug ? " Add new agents to user profile's agentProfiles array." : ""} List what changed.`);

  return parts.join("\n");
}
