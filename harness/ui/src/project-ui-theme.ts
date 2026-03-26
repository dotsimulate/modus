import type { ProjectUiState } from "../../sdk/index";
import { modus } from "./modusClient";

const THEME_STYLE_ID = "modus-project-theme";
const FONT_STYLE_ID = "modus-project-font";
let loadVersion = 0;

function upsertStyle(id: string, css: string | null | undefined) {
  const existing = document.getElementById(id) as HTMLStyleElement | null;
  if (!css || !css.trim()) {
    existing?.remove();
    return;
  }

  const el = existing ?? document.createElement("style");
  el.id = id;
  el.textContent = css;
  if (!existing) document.head.appendChild(el);
}

export function applyProjectUiState(state: ProjectUiState | null) {
  upsertStyle(THEME_STYLE_ID, state?.activeTheme?.css);
  upsertStyle(FONT_STYLE_ID, state?.activeFont?.css);
}

export async function loadAndApplyProjectUiState(cwd?: string): Promise<ProjectUiState | null> {
  const currentVersion = ++loadVersion;
  if (!cwd) {
    if (currentVersion === loadVersion) applyProjectUiState(null);
    return null;
  }

  try {
    const state = await modus.getProjectUiState(cwd);
    if (currentVersion === loadVersion) applyProjectUiState(state);
    return state;
  } catch {
    if (currentVersion === loadVersion) applyProjectUiState(null);
    return null;
  }
}
