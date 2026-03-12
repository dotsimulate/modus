import { useEffect, useState } from "react";
import {
  activateProjectFontApi,
  activateProjectMoveApi,
  activateProjectThemeApi,
  fetchProjectUiState,
} from "../api";
import type { ProjectUiState } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import { applyProjectUiState } from "../project-ui-theme";
import { CustomSelect } from "../components/CustomSelect";
import { basename } from "../utils/format";
import type { WidgetBase, WidgetDef, WidgetProps } from "./index";

type ProjectThemeConfig = WidgetBase & {
  type: "project-theme";
};

function ProjectThemeWidget(_props: WidgetProps<ProjectThemeConfig>) {
  const { activeCwd, activeUP, activeUserProfile } = useProfiles();
  const [state, setState] = useState<ProjectUiState | null>(null);
  const [busy, setBusy] = useState<"theme" | "font" | "create" | null>(null);
  const [error, setError] = useState<string>("");
  const [themePrompt, setThemePrompt] = useState("");

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

  async function handleCreateTheme() {
    const prompt = themePrompt.trim();
    if (!activeCwd || !prompt) return;
    setBusy("create");
    setError("");
    try {
      const result = await activateProjectMoveApi({
        moveName: "create-theme",
        inputs: { prompt },
        cwd: activeCwd,
        userProfile: activeUserProfile ?? undefined,
        forceNewSession: true,
      });
      setThemePrompt("");
      if (result.spawnedSessionId) {
        _props.onSelectSession(result.spawnedSessionId);
        return;
      }
      setError("create-theme did not return a spawned session");
    } catch (err: any) {
      setError(err?.message || "failed to start theme creation");
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

  const themes = (state?.themes.filter((item) => !item.archived) ?? []).map((t) => ({
    value: t.id,
    label: t.label,
  }));
  const fonts = (state?.fonts.filter((item) => !item.archived) ?? []).map((f) => ({
    value: f.id,
    label: f.label,
  }));

  return (
    <div className="project-theme-widget">
      <div className="project-theme-meta">
        <div className="project-theme-chip-row">
          <span className="project-theme-chip">{basename(activeCwd)}</span>
          {activeUP?.displayName && <span className="project-theme-chip">{activeUP.displayName}</span>}
        </div>
        <div className="project-theme-path">{activeCwd}</div>
      </div>

      <div className="pt-controls">
        <label className="pt-field">
          <span className="pt-label">theme</span>
          <CustomSelect
            options={themes}
            value={state?.activeTheme?.id ?? ""}
            placeholder={themes.length ? "select theme" : "no themes"}
            disabled={!themes.length || busy !== null}
            onChange={handleThemeChange}
          />
        </label>
        <label className="pt-field">
          <span className="pt-label">font</span>
          <CustomSelect
            options={fonts}
            value={state?.activeFont?.id ?? ""}
            placeholder={fonts.length ? "select font" : "no fonts"}
            disabled={!fonts.length || busy !== null}
            onChange={handleFontChange}
          />
        </label>
      </div>

      <div className="pt-create">
        <label className="pt-field">
          <span className="pt-label">create theme</span>
          <textarea
            className="pt-create-input"
            value={themePrompt}
            onChange={(e) => setThemePrompt(e.target.value)}
            placeholder="describe the vibe, palette, or direction..."
            rows={3}
            disabled={busy !== null}
          />
        </label>
        <button
          className="pt-create-btn"
          onClick={handleCreateTheme}
          disabled={!activeCwd || !themePrompt.trim() || busy !== null}
        >
          launch theme session
        </button>
      </div>

      {busy && <div className="project-theme-busy">applying {busy}...</div>}
      {error && <div className="project-theme-error">{error}</div>}
    </div>
  );
}

const def: WidgetDef = { type: "project-theme", component: ProjectThemeWidget };
export default def;
