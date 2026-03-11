import { useEffect, useState } from "react";
import {
  activateProjectFontApi,
  activateProjectThemeApi,
  fetchProjectUiState,
} from "../api";
import type { ProjectUiState } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { applyProjectUiState } from "../project-ui-theme";
import type { WidgetBase, WidgetDef, WidgetProps } from "./index";

type ProjectThemeConfig = WidgetBase & {
  type: "project-theme";
};

function basename(path: string | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

function ProjectThemeWidget(_props: WidgetProps<ProjectThemeConfig>) {
  const { activeCwd, activeUP } = useProfiles();
  const [state, setState] = useState<ProjectUiState | null>(null);
  const [busy, setBusy] = useState<"theme" | "font" | null>(null);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!activeCwd) {
        if (alive) {
          setState(null);
          setError("");
        }
        return;
      }

      try {
        const next = await fetchProjectUiState(activeCwd);
        if (!alive) return;
        setState(next);
        setError("");
      } catch (err: any) {
        if (!alive) return;
        setState(null);
        setError(err?.message || "failed to load project theme state");
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, [activeCwd]);

  async function handleThemeChange(themeId: string) {
    if (!activeCwd || !state || !themeId || themeId === state.activeTheme?.id) return;
    setBusy("theme");
    setError("");
    try {
      const activeTheme = await activateProjectThemeApi(activeCwd, themeId);
      const next = { ...state, activeTheme };
      setState(next);
      applyProjectUiState(next);
    } catch (err: any) {
      setError(err?.message || "failed to activate theme");
    } finally {
      setBusy(null);
    }
  }

  async function handleFontChange(fontId: string) {
    if (!activeCwd || !state || !fontId || fontId === state.activeFont?.id) return;
    setBusy("font");
    setError("");
    try {
      const activeFont = await activateProjectFontApi(activeCwd, fontId);
      const next = { ...state, activeFont };
      setState(next);
      applyProjectUiState(next);
    } catch (err: any) {
      setError(err?.message || "failed to activate font");
    } finally {
      setBusy(null);
    }
  }

  if (!activeCwd) {
    return <div className="dash-empty">select a project to load themes</div>;
  }

  if (!state && !error) {
    return <div className="dash-empty">loading themes...</div>;
  }

  const themes = state?.themes.filter((item) => !item.archived) ?? [];
  const fonts = state?.fonts.filter((item) => !item.archived) ?? [];

  return (
    <div className="project-theme-widget">
      <div className="project-theme-meta">
        <div className="project-theme-chip-row">
          <span className="project-theme-chip">{basename(activeCwd)}</span>
          {activeUP?.displayName && <span className="project-theme-chip">{activeUP.displayName}</span>}
        </div>
        <div className="project-theme-path">{activeCwd}</div>
      </div>

      <div className="project-theme-controls">
        <label className="project-theme-field">
          <span className="project-theme-label">theme</span>
          <select
            className="project-theme-select"
            value={state?.activeTheme?.id ?? ""}
            onChange={(e) => handleThemeChange(e.target.value)}
            disabled={!themes.length || busy !== null}
          >
            <option value="" disabled>{themes.length ? "select theme" : "no themes"}</option>
            {themes.map((theme) => (
              <option key={theme.id} value={theme.id}>{theme.label}</option>
            ))}
          </select>
        </label>

        <label className="project-theme-field">
          <span className="project-theme-label">font</span>
          <select
            className="project-theme-select"
            value={state?.activeFont?.id ?? ""}
            onChange={(e) => handleFontChange(e.target.value)}
            disabled={!fonts.length || busy !== null}
          >
            <option value="" disabled>{fonts.length ? "select font" : "no fonts"}</option>
            {fonts.map((font) => (
              <option key={font.id} value={font.id}>{font.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="project-theme-status">
        <span>
          active theme: <strong>{state?.activeTheme?.label ?? "default"}</strong>
        </span>
        <span>
          active font: <strong>{state?.activeFont?.label ?? "default"}</strong>
        </span>
      </div>

      {busy && <div className="project-theme-busy">applying {busy}...</div>}
      {error && <div className="project-theme-error">{error}</div>}
    </div>
  );
}

const def: WidgetDef = { type: "project-theme", component: ProjectThemeWidget };
export default def;
