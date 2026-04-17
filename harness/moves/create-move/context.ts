import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { MoveContext, SubmitResult } from "../../move-types";

type MoveSummary = {
  name: string;
  moveJson: string;
  hasContext: boolean;
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function listExistingMoves(cwd: string): MoveSummary[] {
  const movesDir = join(cwd, ".modus", "moves");
  if (!existsSync(movesDir)) return [];

  return readdirSync(movesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(movesDir, entry.name);
      const moveJson = readText(join(dir, "move.json")) ?? "";
      return {
        name: entry.name,
        moveJson: moveJson.slice(0, 1200).trim(),
        hasContext: existsSync(join(dir, "context.ts")),
      };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateMoveConfig(data: Record<string, unknown>): string | null {
  if (typeof data.name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(data.name)) {
    return "name must be a lowercase-kebab string";
  }
  if (typeof data.label !== "string" || !data.label.trim()) return "label is required";
  if (typeof data.description !== "string" || !data.description.trim()) return "description is required";
  if (data.mode !== undefined && !["inline", "branch", "background"].includes(String(data.mode))) {
    return 'mode must be "inline" | "branch" | "background"';
  }
  if (data.inputs !== undefined && !Array.isArray(data.inputs)) return "inputs must be an array";
  if (data.schema !== undefined && !isRecord(data.schema)) return "schema must be an object";
  return null;
}

export async function gather(ctx: MoveContext): Promise<string> {
  const moves = listExistingMoves(ctx.cwd);
  const movesSection = moves.length > 0
    ? moves
        .slice(0, 5)
        .map((move) =>
          [
            `- \`${move.name}\`${move.hasContext ? " (has context.ts)" : ""}`,
            "  ```json",
            move.moveJson,
            "  ```",
          ].join("\n"),
        )
        .join("\n\n")
    : "No existing user moves in `.modus/moves/`.";

  return [
    "# Create Move Move",
    "",
    "You are inside the `create-move` move.",
    "Your job is to scaffold a new user-space move at `.modus/moves/<name>/move.json`.",
    "This scaffold is JSON-only — user-created moves do NOT ship with a TypeScript `context.ts`.",
    "Put the full gather prompt inline on `gatherPrompt` (or `prompt`) so the move runs without a context.ts file.",
    "",
    "## What a move is",
    "Moves are the user-facing invocation primitive. They define WHAT the user wants done right now.",
    "- `inline` (default): merges `gather` output into the current user message.",
    "- `branch`: spawns a sibling session with the given `agentProfile`.",
    "- `background`: fire-and-forget.",
    "- `persistent: true`: ambient — re-runs gather every turn, no submit lifecycle.",
    "",
    "## Submit shape",
    "```ts",
    "type SubmitData = {",
    "  name: string;              // kebab-case — directory name at .modus/moves/<name>/",
    "  label: string;             // display label in the move picker",
    "  description: string;       // one-line description",
    "  icon?: string;             // lucide icon name",
    "  mode?: \"inline\" | \"branch\" | \"background\";",
    "  persistent?: boolean;",
    "  inputs?: MoveInput[];      // user form fields shown before activation",
    "  schema?: Record<string, unknown>;  // optional JSON Schema for modus_submit validation",
    "  schemaHint?: string;       // compact shape string shown to the model",
    "  submit?: { required?: boolean; retryOnInvalid?: boolean; maxAttempts?: number };",
    "  session?: { profileOverride?: string | null; afterSubmit?: \"continue\" | \"end\" | string };",
    "  agentProfile?: string;     // for branch/background modes",
    "  gatherPrompt?: string;     // full prompt string returned by the inline gather fallback",
    "  prompt?: string | null;    // alias for gatherPrompt — the one that actually lands on disk",
    "  tags?: string[];",
    "};",
    "",
    "type MoveInput = {",
    "  name: string;",
    "  label?: string;",
    "  type: \"text\" | \"textarea\" | \"select\" | \"toggle\" | \"number\";",
    "  options?: string[] | string;",
    "  required?: boolean;",
    "  default?: unknown;",
    "  placeholder?: string;",
    "};",
    "```",
    "",
    "## Notes",
    "- If the user supplies `gatherPrompt`, it is persisted as `move.json.prompt` so the move-runner uses it as the inline fallback.",
    "- If the user wants real logic (validation in onSubmit, API ops, widgets) — tell them to author `context.ts` manually after scaffolding. This move does not generate TypeScript.",
    "- The saved file path will be `.modus/moves/<name>/move.json`.",
    "",
    "## Existing user moves (reference)",
    movesSection,
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
  const error = validateMoveConfig(data);
  if (error) return { error };

  const name = String(data.name);
  const moveDir = join(ctx.cwd, ".modus", "moves", name);
  mkdirSync(moveDir, { recursive: true });

  // Normalize gatherPrompt → prompt so the move-runner uses it as the inline fallback.
  const { gatherPrompt, ...rest } = data as Record<string, unknown>;
  const config: Record<string, unknown> = { ...rest };
  if (typeof gatherPrompt === "string" && gatherPrompt.trim().length > 0 && typeof config.prompt !== "string") {
    config.prompt = gatherPrompt;
  }

  const filePath = join(moveDir, "move.json");
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

  return {
    message: `Move scaffolded at ${filePath}`,
  };
}
