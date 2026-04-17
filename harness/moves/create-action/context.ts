import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MoveContext, SubmitResult } from "../../move-types";

type ActionSummary = {
  name: string;
  actionJson: string;
  hasContext: boolean;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listExistingActions(cwd: string): ActionSummary[] {
  const actionsDir = join(cwd, ".modus", "actions");
  if (!existsSync(actionsDir)) return [];

  return readdirSync(actionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(actionsDir, entry.name);
      const actionJson = readText(join(dir, "action.json")) ?? "";
      return {
        name: entry.name,
        actionJson: actionJson.slice(0, 1200).trim(),
        hasContext: existsSync(join(dir, "context.ts")),
      };
    });
}

function listAgentProfiles(cwd: string): string[] {
  const dir = join(cwd, ".modus", "profiles", "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateActionConfig(data: Record<string, unknown>): string | null {
  if (typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    return "name must be a lowercase-kebab string";
  }
  if (typeof data.description !== "string" || !data.description.trim()) {
    return "description is required";
  }
  if (typeof data.agentProfile !== "string" || !data.agentProfile.trim()) {
    return "agentProfile is required";
  }
  if (!isRecord(data.trigger)) return "trigger must be an object";
  const trigger = data.trigger as Record<string, unknown>;
  const validTypes = new Set(["interval", "webhook", "manual", "action", "session"]);
  if (typeof trigger.type !== "string" || !validTypes.has(trigger.type)) {
    return 'trigger.type must be one of "interval" | "webhook" | "manual" | "action" | "session"';
  }
  if (trigger.type === "interval" && typeof trigger.every !== "string") {
    return "interval trigger requires 'every' (e.g. '5m', '1h')";
  }
  if (trigger.type === "action" && typeof trigger.source !== "string") {
    return "action-chain trigger requires 'source'";
  }
  return null;
}

export async function gather(ctx: MoveContext): Promise<string> {
  const actions = listExistingActions(ctx.cwd);
  const profiles = listAgentProfiles(ctx.cwd);

  const actionsSection = actions.length > 0
    ? actions
        .slice(0, 5)
        .map((action) =>
          [
            `- \`${action.name}\`${action.hasContext ? " (has context.ts)" : ""}`,
            "  ```json",
            action.actionJson,
            "  ```",
          ].join("\n"),
        )
        .join("\n\n")
    : "No existing actions found in `.modus/actions/`.";

  const profilesSection = profiles.length > 0
    ? profiles.map((name) => `- \`${name}\``).join("\n")
    : "No project agent profiles in `.modus/profiles/agents/` — create one first via `create-profile`.";

  return [
    "# Create Action Move",
    "",
    "You are inside the `create-action` move.",
    "Your job is to scaffold a new automated action at `.modus/actions/<name>/`.",
    "Each action is a directory containing `action.json` (config) and `context.ts` (gather + optional afterRun).",
    "",
    "## Workflow",
    "1. Ask focused questions only if the user's intent is unclear (what should fire it, what the agent should do, how often).",
    "2. Pick an `agentProfile` that already exists — do not invent one. If none fits, tell the user to create a profile first.",
    "3. Write `context.ts` with a `gather(ctx)` function that returns a prompt string for the action's agent. Keep it small and mechanical.",
    "4. Submit the action config + the context.ts source through `modus_submit`. Harness will create the directory and write both files.",
    "",
    "## Available agent profiles",
    profilesSection,
    "",
    "## Trigger types",
    "- `interval` — fires on a timer. Requires `every` (e.g. `\"5m\"`, `\"1h\"`). Optional `from`, `activeHours`.",
    "- `webhook` — HTTP POST to `/api/actions/<name>/hook`. Token auto-generated.",
    "- `manual` — fired from UI or `POST /api/actions/<name>/trigger`.",
    "- `action` — chains after another action completes. Requires `source` and `condition` (`\"any\"|\"done\"|\"error\"`).",
    "- `session` — fires on session events. Requires `on` (role+round+at, or `\"archived\"`/`\"deleted\"`).",
    "",
    "## Submit shape",
    "```ts",
    "type SubmitData = {",
    "  name: string;              // kebab-case — also the directory name",
    "  description: string;",
    "  enabled?: boolean;         // default false",
    "  agentProfile: string;      // must exist in .modus/profiles/agents/",
    "  trigger: Trigger;          // see trigger types above",
    "  maxRuns?: number;",
    "  maxTurns?: number;",
    "  cycleInterval?: string;    // e.g. \"1h\", \"1d\"",
    "  maxCycles?: number;",
    "  concurrency?: number;",
    "  onExhausted?: \"archive\" | \"idle\" | \"restart\";",
    "  inputs?: Record<string, unknown>;  // static inputs to ctx.inputs",
    "  tags?: string[];",
    "  contextTs?: string;        // full text of context.ts to write alongside action.json",
    "};",
    "```",
    "",
    "If `contextTs` is omitted, a minimal stub will be written. Prefer to provide a real `gather` body that references",
    "`ctx.trigger`, `ctx.inputs`, and returns a concrete prompt for the agent.",
    "",
    "## Example `context.ts`",
    "```ts",
    "import type { ActionContext, ActionModule } from \"../../action-types\";",
    "",
    "export async function gather(ctx: ActionContext): Promise<string> {",
    "  return [",
    "    `Run ${ctx.runNumber} of action ${ctx.actionName}.`,",
    "    `Trigger: ${ctx.trigger.type}.`,",
    "    `Do the work described in the action description and report back.`,",
    "  ].join(\"\\n\");",
    "}",
    "```",
    "",
    "## Existing actions (reference)",
    actionsSection,
    "",
    "## Submit",
    `Call \`modus_submit\` with token \`${ctx.token}\` and a payload matching: \`${ctx.schema}\``,
    `Date: ${ctx.date ?? "unknown"}`,
  ].join("\n");
}

const DEFAULT_CONTEXT_TS = `import type { ActionContext } from "../../action-types";

export async function gather(ctx: ActionContext): Promise<string> {
  return [
    \`Run \${ctx.runNumber} of action \${ctx.actionName}.\`,
    \`Trigger: \${ctx.trigger.type}.\`,
    "TODO: describe what the agent should do this run.",
  ].join("\\n");
}
`;

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
): Promise<SubmitResult> {
  const error = validateActionConfig(data);
  if (error) return { error };

  const name = String(data.name);
  const actionDir = join(ctx.cwd, ".modus", "actions", name);
  mkdirSync(actionDir, { recursive: true });

  const contextTs = typeof data.contextTs === "string" && data.contextTs.trim().length > 0
    ? data.contextTs
    : DEFAULT_CONTEXT_TS;

  // Strip contextTs from the action.json payload — it is a sidecar file.
  const { contextTs: _omit, ...configRest } = data as Record<string, unknown>;
  const config = {
    enabled: false,
    ...configRest,
  };

  const actionJsonPath = join(actionDir, "action.json");
  const contextPath = join(actionDir, "context.ts");

  writeFileSync(actionJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  writeFileSync(contextPath, contextTs, "utf-8");

  return {
    message: `Action scaffolded at ${actionDir}`,
  };
}
