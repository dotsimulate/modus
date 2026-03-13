import type { PromptGatherContext } from "../../gather-types";

export async function gather(ctx: PromptGatherContext): Promise<string> {
  const { depth = "quick", areas = "all", focus, text } = ctx.inputs as Record<string, string>;

  const depthLines: Record<string, string> = {
    quick: "Quick pass — top-level structure, languages, key entry points. 2-3 minutes max.",
    thorough: "Thorough exploration — read key files, trace import graphs, map dependencies.",
    audit: "Full audit — dead code, missing tests, security concerns, config drift. Be exhaustive.",
  };

  const areaLines: Record<string, string> = {
    frontend: "Scope: frontend only — components, styles, routing, state, build config.",
    backend: "Scope: backend only — API routes, database, middleware, auth, server config.",
    infra: "Scope: infra only — deployment, CI/CD, Docker, env config, tooling.",
    tests: "Scope: tests only — coverage, patterns, fixtures, what's missing.",
    config: "Scope: config only — package.json, tsconfig, env files, MO config, build settings.",
  };

  const parts = [`Explore ${ctx.project.name}. Read-only — do not create, modify, or delete any files.`];

  if (depthLines[depth]) parts.push("", depthLines[depth]!);
  if (areaLines[areas]) parts.push("", areaLines[areas]!);
  if (focus) parts.push("", `Focus: ${focus}`);
  if (text) parts.push("", text);

  parts.push("", "Report: structure, languages, tooling, agent profiles/actions if any, patterns, suggestions. Bullet points, not paragraphs. If .modus/ exists, describe it.");

  return parts.join("\n");
}
