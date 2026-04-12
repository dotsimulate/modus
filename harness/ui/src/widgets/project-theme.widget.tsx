import { useEffect, useState } from "react";
import { modus } from "../modusClient";
import type { ProjectUiState } from "../../../sdk/index";
import { useProfiles } from "../providers/ProfileContext";
import { applyProjectUiState } from "../project-ui-theme";
import { CustomSelect } from "../components/CustomSelect";
import { PromptComposer } from "../components/PromptComposer";
import type { WidgetBase, WidgetProps } from "./types";

type ProjectThemeConfig = WidgetBase & {
  type: "project-theme";
};

export default function ProjectThemeWidget({ onSelectSession, pageContext }: WidgetProps<ProjectThemeConfig>) {
  const { activeCwd, projectRoot, activeUserProfile } = useProfiles();
  const themeCwd = projectRoot ?? activeCwd;
  const [state, setState] = useState<ProjectUiState | null>(null);
  const [busy, setBusy] = useState<"theme" | "font" | "create" | null>(null);
  const [error, setError] = useState<string>("");
  const [themePrompt, setThemePrompt] = useState("");

  useEffect(() => {
    let alive = true;

    async function load() {
      if (!themeCwd) {
        if (alive) {
          setState(null);
          setError("");
        }
        return;
      }

      try {
        const next = await modus.getProjectUiState(themeCwd);
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
  }, [themeCwd]);

  async function handleThemeChange(themeId: string) {
    if (!themeCwd || !state || !themeId || themeId === state.activeTheme?.id) return;
    setBusy("theme");
    setError("");
    try {
      const activeTheme = await modus.activateProjectTheme(themeCwd, themeId);
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
    if (!themeCwd || !state || !fontId || fontId === state.activeFont?.id) return;
    setBusy("font");
    setError("");
    try {
      const activeFont = await modus.activateProjectFont(themeCwd, fontId);
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
    if (!themeCwd || !prompt) return;
    setBusy("create");
    setError("");
    try {
      const result = await modus.activateProjectMove({
        moveName: "create-theme",
        inputs: { prompt },
        cwd: themeCwd,
        userProfile: activeUserProfile ?? undefined,
        forceNewSession: true,
      });
      setThemePrompt("");
      if (result.spawnedSessionId) {
        if (pageContext) { pageContext.set("selectedSession", result.spawnedSessionId); } else { onSelectSession(result.spawnedSessionId); }
        return;
      }
      setError("create-theme did not return a spawned session");
    } catch (err: any) {
      setError(err?.message || "failed to start theme creation");
    } finally {
      setBusy(null);
    }
  }

  if (!themeCwd) {
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
      <div className="project-theme-grid">
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
            <PromptComposer
              compact
              value={themePrompt}
              onChange={setThemePrompt}
              onSubmit={handleCreateTheme}
              submitLabel="launch theme session"
              submitDisabled={!themeCwd || !themePrompt.trim() || busy !== null}
              disabled={busy !== null}
              placeholder="describe the vibe, palette, or direction..."
              rows={3}
            />
          </label>
        </div>
      </div>

      {busy && <div className="project-theme-busy">applying {busy}...</div>}
      {error && <div className="project-theme-error">{error}</div>}
    </div>
  );
}
