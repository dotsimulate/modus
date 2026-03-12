import { registerTheme, listThemes, getActiveTheme } from "../../project-ui";
import type { MoveContext, SubmitResult } from "../../move-types";

export async function gather(ctx: MoveContext): Promise<Record<string, unknown>> {
  const activeTheme = getActiveTheme(ctx.cwd);
  const themes = listThemes(ctx.cwd).map((theme) => ({
    id: theme.id,
    label: theme.label,
    active: theme.active,
    notes: theme.notes ?? "",
  }));

  return {
    date: new Date().toISOString().split("T")[0],
    activeThemeId: activeTheme?.id ?? null,
    activeThemeLabel: activeTheme?.label ?? null,
    activeThemeFile: activeTheme ? `.modus/ui/${activeTheme.file}` : null,
    availableThemes: themes,
    requiredVars: ["--bg", "--text", "--accent", "--border", "--flash-user", "--flash-assistant"],
  };
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
