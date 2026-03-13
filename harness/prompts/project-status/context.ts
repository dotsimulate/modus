import type { PromptGatherContext } from "../../gather-types";

export async function gather(ctx: PromptGatherContext): Promise<string> {
  const { depth = "glance", includeModus = "yes", text } = ctx.inputs as Record<string, string>;

  const depthLine = depth === "glance"
    ? "Quick glance — highlights only, 30 seconds to read."
    : "Full report — read key files, check for issues, be thorough.";

  // Gather git and filesystem context
  const [status, log, branch, ls] = await Promise.all([
    ctx.git("status", "--short"),
    ctx.git("log", "--oneline", "-5"),
    ctx.git("branch", "--show-current"),
    ctx.run("ls -1"),
  ]);

  const parts = [
    `Project status: ${ctx.project.paths.join(", ")}`,
    "",
    depthLine,
    "",
    `Git:`,
    status || "(clean)",
    "",
    `Recent:`,
    log,
    "",
    `Branch: ${branch}`,
    "",
    `Structure:`,
    ls,
  ];

  if (text) parts.push("", `Focus: ${text}`);

  if (includeModus === "yes") {
    const [agents, actionList, prompts, projectJson] = await Promise.all([
      ctx.read(".modus/profiles/agents"),
      ctx.run("ls -1 .modus/actions/ 2>/dev/null || echo 'none'"),
      ctx.read(".modus/prompts"),
      ctx.read(".modus/_project.json"),
    ]);

    parts.push(
      "",
      "MO config:",
      "",
      `Agents: ${agents}`,
      `Actions: ${actionList}`,
      `Prompts: ${prompts}`,
      `Project: ${projectJson}`,
    );
  }

  parts.push("", `Report: branch, uncommitted changes, recent direction${includeModus === "yes" ? ", configured agents/actions/prompts" : ""}, anything broken or stale, next steps. Bullet points.`);

  return parts.join("\n");
}
