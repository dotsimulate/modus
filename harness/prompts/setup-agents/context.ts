import type { PromptGatherContext } from "../../gather-types";

export async function gather(ctx: PromptGatherContext): Promise<string> {
  const { archetype = "custom", description = "", text } = ctx.inputs as Record<string, string>;

  const archetypeLines: Record<string, string> = {
    reviewer: "Archetype: reviewer — reads diffs, checks bugs/style/security. Read-only, reports findings.",
    runner: "Archetype: runner — executes commands, runs tests, builds. Needs shell + file write.",
    monitor: "Archetype: monitor — watches changes, checks health, reports status. For recurring runs.",
    researcher: "Archetype: researcher — explores codebases, reads docs, summarizes. Read-only, high context.",
    writer: "Archetype: writer — docs, READMEs, changelogs. File write, benefits from project context.",
  };

  const parts = [`Set up agents for ${ctx.project.name}.`];

  if (archetypeLines[archetype]) parts.push("", archetypeLines[archetype]!);

  parts.push("", `Description: ${description}`);
  if (text) parts.push(text);

  const archetypeRef = archetype === "custom" ? "" : ` based on the ${archetype} archetype`;
  parts.push("", `Create profiles in .modus/profiles/agents/<name>.json${archetypeRef}. Use the create-profile move for the live schema. Only create what was asked for. Set reasonable maxTurns and permissions.`);

  return parts.join("\n");
}
