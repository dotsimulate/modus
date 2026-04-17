import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MoveContext, SubmitResult } from "../../move-types";

type ProfileSummary = {
  file: string;
  preview: string;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listProfilesAt(root: string): ProfileSummary[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const text = readText(join(root, name)) ?? "";
      return {
        file: name,
        preview: text.slice(0, 1200).trim(),
      };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateProfile(data: Record<string, unknown>): string | null {
  if (typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    return "name must be a lowercase-kebab string (used as the filename)";
  }
  if (typeof data.prompt !== "string" || !data.prompt.trim()) {
    return "prompt is required";
  }
  if (typeof data.description !== "string" || !data.description.trim()) {
    return "description is required";
  }
  if (data.effort !== undefined && !["off", "low", "medium", "high", "max"].includes(String(data.effort))) {
    return 'effort must be one of "off" | "low" | "medium" | "high" | "max"';
  }
  if (data.promptMode !== undefined && !["custom", "append"].includes(String(data.promptMode))) {
    return 'promptMode must be "custom" or "append"';
  }
  if (data.mcpServers !== undefined && !isRecord(data.mcpServers)) {
    return "mcpServers must be an object";
  }
  return null;
}

export async function gather(ctx: MoveContext): Promise<string> {
  const projectProfilesDir = join(ctx.cwd, ".modus", "profiles", "agents");
  const builtinProfilesDir = join(ctx.cwd, "harness", "profiles", "agents");

  const projectProfiles = listProfilesAt(projectProfilesDir);
  const builtinProfiles = listProfilesAt(builtinProfilesDir);

  const projectSection = projectProfiles.length > 0
    ? projectProfiles.map((p) => `- \`${p.file}\`\n\`\`\`json\n${p.preview}\n\`\`\``).join("\n\n")
    : "No project profiles exist yet in `.modus/profiles/agents/`.";

  const builtinSection = builtinProfiles.length > 0
    ? builtinProfiles.slice(0, 3).map((p) => `- \`${p.file}\`\n\`\`\`json\n${p.preview}\n\`\`\``).join("\n\n")
    : "No built-in profiles detected.";

  return [
    "# Create Profile Move",
    "",
    "You are inside the `create-profile` move.",
    "Your job is to create a project-local agent profile at `.modus/profiles/agents/<name>.json`.",
    "The filename (without `.json`) is the profile id — it must match the submitted `name`.",
    "",
    "## Workflow",
    "1. If the user is specific about provider/model/tools/role, write the profile immediately.",
    "2. If the user is vague, ask focused questions: identity/role, provider+model, tool posture, permission default.",
    "3. Write a dense, directive `prompt` (2–6 sentences) — start with \"You are ...\", reference what the agent DOES and AVOIDS.",
    "4. Submit the full profile object through `modus_submit`.",
    "",
    "## Profile shape (common fields)",
    "```ts",
    "type AgentProfile = {",
    "  name: string;                 // filename id (kebab-case)",
    "  description: string;          // one-line description shown in UI",
    "  prompt: string;                // system prompt body",
    "  promptMode?: \"custom\" | \"append\"; // append = add to provider default prompt",
    "  provider?: string;             // \"anthropic\" | \"claude-code\" | \"codex\" | \"cursor\" | \"gemini-cli\" | ...",
    "  model?: string;",
    "  effort?: \"off\" | \"low\" | \"medium\" | \"high\" | \"max\";",
    "  maxTurns?: number;",
    "  tools?: string[];              // whitelist",
    "  disallowedTools?: string[];    // blacklist",
    "  loadProjectSettings?: boolean;",
    "  permissionPolicy?: \"bypass\" | \"ask\" | { default: \"approve\" | \"ask\"; autoApprove?: string[]; requireApproval?: string[] };",
    "  mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> } | { type: \"sse\" | \"http\"; url: string; headers?: Record<string, string> }>;",
    "  ui?: { label?: string; placeholder?: string; emptyTitle?: string; emptySubtitle?: string; showThinking?: boolean; showToolCalls?: boolean; panelWidgets?: string[] };",
    "  contextWindow?: number;",
    "  maxOutputTokens?: number;",
    "  maxBudgetUsd?: number;",
    "  env?: Record<string, string>;",
    "  cwd?: string;",
    "  additionalDirectories?: string[];",
    "  cwdSuggestions?: string[];",
    "  moves?: Array<{ name: string; inputs?: Record<string, unknown> }>;",
    "};",
    "```",
    "",
    "## Existing project profiles",
    projectSection,
    "",
    "## Built-in profiles (reference — do NOT copy blindly)",
    builtinSection,
    "",
    "## Notes",
    "- Omit optional fields that you don't need. Don't pad with nulls or defaults.",
    "- Use `permissionPolicy: \"bypass\"` only when the agent genuinely needs unrestricted access. Otherwise prefer `{ default: \"approve\", requireApproval: [\"Write\", \"Edit\", \"Bash\"] }` or similar.",
    "- The saved file path will be `.modus/profiles/agents/<name>.json`.",
    "",
    "## Submit",
    `Call \`modus_submit\` with token \`${ctx.token}\` and a payload matching: \`${ctx.schema}\``,
    `Date: ${ctx.date ?? "unknown"}`,
  ].join("\n");
}

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
): Promise<SubmitResult> {
  const error = validateProfile(data);
  if (error) return { error };

  const name = String(data.name);
  const profilesDir = join(ctx.cwd, ".modus", "profiles", "agents");
  mkdirSync(profilesDir, { recursive: true });

  // Drop `name` from the written JSON — the filename IS the id. Harness profiles use filename-as-id.
  const { name: _dropName, ...rest } = data as Record<string, unknown>;

  const filePath = join(profilesDir, `${name}.json`);
  writeFileSync(filePath, `${JSON.stringify(rest, null, 2)}\n`, "utf-8");

  return {
    message: `Profile saved to ${filePath}`,
  };
}
