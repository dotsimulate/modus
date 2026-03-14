import { registerTheme, listThemes, getActiveTheme } from "../../project-ui";
import type { MoveContext, SubmitResult } from "../../move-types";

export async function gather(ctx: MoveContext): Promise<string> {
  const { prompt: userPrompt } = ctx.inputs as Record<string, string>;

  const activeTheme = getActiveTheme(ctx.cwd);
  const themes = listThemes(ctx.cwd).map((theme) => ({
    id: theme.id,
    label: theme.label,
    active: theme.active,
    notes: theme.notes ?? "",
  }));

  const activeThemeFile = activeTheme ? `.modus/ui/${activeTheme.file}` : null;
  const date = ctx.date ?? new Date().toISOString().split("T")[0];

  const themesSection = themes.map(t =>
    `- ${t.label} (${t.id})${t.active ? " [active]" : ""}${t.notes ? ` — ${t.notes}` : ""}`
  ).join("\n");

  const requiredVars = ["--bg", "--text", "--accent", "--border", "--flash-user", "--flash-assistant"];

  const parts = [
    "You are running the create-theme move. Your job is to design and create a project-local harness theme.",
    "",
    userPrompt
      ? `User prompt: ${userPrompt}`
      : "No prompt provided — invent a theme that fits the project aesthetic.",
    "",
    `Date: ${date}`,
    `Current active theme: ${activeTheme?.label ?? "none"} (${activeTheme?.id ?? "none"})`,
    `Current active theme file: ${activeThemeFile ?? "none"}`,
    "",
    "Existing themes:",
    themesSection || "(none)",
    "",
    "Required variables (must be present):",
    ...requiredVars.map(v => `- ${v}`),
    "",
    "## Token map — what each group controls in the UI",
    "",
    "**Backgrounds** — `--bg` is the base canvas (chat area, input, sidebar). `--bg-raised` lifts cards and tool call blocks. `--bg-surface` is table headers, code block headers, focused inputs. `--bg-hover` is row/item hover. `--thinking` is the agent thinking block background.",
    "",
    "**Borders** — `--border` is used on almost every edge in the UI. `--border-active` is focused inputs, popovers, active tool borders. Keep these subtle — they frame dense content.",
    "",
    "**Text** — a 7-stop ramp from `--text` (primary) down to `--text-muted` (near-invisible labels). `--accent` is used for markdown headings, strong text, checkboxes, and the logo — it should be the most prominent non-body color. Keep the ramp legible; do not collapse stops together.",
    "",
    "**Status** — `--success` runs sessions and connected dots. `--warning` colors running tools, in-progress todo items, the login field hover/focus glow, and schedule dots. `--error` colors the stop button and login errors. These carry functional meaning — keep them readable and distinct from each other. **Do NOT default `--warning` to amber or orange.** Choose a color that fits this theme's palette while remaining visually distinct from `--success` and `--error`.",
    "",
    "**Dots** — `--dot-running`, `--dot-idle`, `--dot-done`, `--dot-error`, `--dot-connected` — small 6px status indicators on session items and the status bar.",
    "",
    "**Tool calls** — `--tool-running` is the spinner and running tool name. `--tool-ok` is the success dot. `--tool-error` is the error dot and name. `--tool-commit` is the git commit dot, label, and hash. These appear frequently in dense sessions — they should be clearly distinct colors.",
    "",
    "**Memory tags** — `--mem-tag-bg`, `--mem-tag-text`, `--mem-tag-border` and their hover variants — subtle chips on memory cards. Keep them very low contrast against the background.",
    "",
    "**Flash colors** — `--flash-user` and `--flash-assistant` are the opening-frame color of a 1-second fade-in animation that plays when a new chat message appears. The color flares briefly, then fades to `--text`. These are expressive palette choices — pick two vivid colors native to this theme. They must differ from each other and from `--text`. Do NOT copy these from any other theme.",
    "",
    "**Login** — `--login-*` tokens are derived from other tokens using `color-mix()`. Copy the derivation pattern from the active theme — do not invent new formulas.",
    "",
    "**Syntax highlighting** — `--syn-keyword`, `--syn-builtin`, `--syn-type`, `--syn-literal`, `--syn-number`, `--syn-string`, `--syn-regexp`, `--syn-symbol`, `--syn-comment`, `--syn-function`, `--syn-variable`, `--syn-tag`, `--syn-attr`, `--syn-addition`, `--syn-deletion` — standard code coloring. Keep contrast legible on `--bg-raised`.",
    "",
    "## Workflow",
    "",
    "1. Decide on a theme id (kebab-case), theme name, and overall palette from the user prompt or invent one.",
    "2. Read the current active theme file for the token list and structure — use it as a structural reference only. Do NOT copy any color values from it. Every color must be chosen for this theme.",
    "3. Write a complete CSS file to `.modus/ui/themes/<themeId>.css` with a single `:root` block covering all tokens present in existing themes.",
    "4. Keep the theme cohesive and high-contrast enough for dense harness usage.",
    "5. Do not edit registry JSON yourself. Registration and activation happen in `onSubmit()`.",
    "",
    "After writing the CSS file, call:",
    "",
    `\`modus_submit\` — token: \`${ctx.token}\` — data: \`${ctx.schema}\``,
    "",
    "- themeId — the id you chose",
    "- themeName — the display name you chose",
    "- cssPath — absolute path to the CSS file you wrote",
    "- activate — true (activate by default unless the user said otherwise)",
    "- notes — brief note describing the theme's vibe",
  ];

  return parts.join("\n");
}

export async function onSubmit(
  ctx: MoveContext,
  data: Record<string, unknown>,
  inputs: Record<string, unknown>,
): Promise<SubmitResult> {
  const themeId = String(data.themeId ?? inputs.themeId ?? "").trim();
  const themeName = String(data.themeName ?? inputs.themeName ?? themeId).trim();
  const cssPath = String(data.cssPath ?? "").trim();
  const notes = String(data.notes ?? inputs.notes ?? "").trim();
  const activate = data.activate === true || inputs.activate === true;

  if (!themeId) return { error: "themeId is required" };
  if (!cssPath) return { error: "cssPath is required" };

  const theme = registerTheme({
    cwd: ctx.cwd,
    themeId,
    themeName,
    cssPath,
    activate,
    notes: notes || undefined,
    source: "move:create-theme",
  });

  return {
    message: activate
      ? `Theme registered and activated: ${theme.label} (${theme.id})`
      : `Theme registered: ${theme.label} (${theme.id})`,
  };
}
