import { useEffect, useState } from "react";
import type { ProjectUiState } from "../../../sdk/index";
import { modus } from "../modusClient";
import { applyProjectUiState } from "../project-ui-theme";

export function ProjectAppearanceSettings({ cwd }: { cwd: string | null | undefined }) {
  const [state, setState] = useState<ProjectUiState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    if (!cwd) {
      setState(null);
      return;
    }
    modus.getProjectUiState(cwd)
      .then((next) => { if (alive) { setState(next); setError(""); } })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "Could not load project appearance"); });
    return () => { alive = false; };
  }, [cwd]);

  const activate = async (kind: "theme" | "font", id: string) => {
    if (!cwd || !state || !id) return;
    setBusy(true);
    setError("");
    try {
      const asset = kind === "theme"
        ? await modus.activateProjectTheme(cwd, id)
        : await modus.activateProjectFont(cwd, id);
      const next = kind === "theme"
        ? { ...state, activeTheme: asset }
        : { ...state, activeFont: asset };
      setState(next);
      applyProjectUiState(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not activate ${kind}`);
    } finally {
      setBusy(false);
    }
  };

  const themes = state?.themes.filter((theme) => !theme.archived) ?? [];
  const fonts = state?.fonts.filter((font) => !font.archived) ?? [];

  return (
    <div className="us-appearance-project">
      <div className="us-section-title">project appearance</div>
      <div className="us-row">
        <span className="us-row-label">project</span>
        <span className="us-info-val" title={cwd ?? undefined}>{cwd || "no active project"}</span>
      </div>
      <div className="us-row">
        <span className="us-row-label">theme</span>
        <select
          className="us-select"
          value={state?.activeTheme?.id ?? ""}
          disabled={!cwd || busy || themes.length === 0}
          onChange={(event) => { void activate("theme", event.target.value); }}
        >
          <option value="">{themes.length ? "select theme" : "no themes"}</option>
          {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
        </select>
      </div>
      <div className="us-row">
        <span className="us-row-label">font</span>
        <select
          className="us-select"
          value={state?.activeFont?.id ?? ""}
          disabled={!cwd || busy || fonts.length === 0}
          onChange={(event) => { void activate("font", event.target.value); }}
        >
          <option value="">{fonts.length ? "select font" : "project default"}</option>
          {fonts.map((font) => <option key={font.id} value={font.id}>{font.label}</option>)}
        </select>
      </div>
      <div className="us-row-hint">stored in this project and applied to every Modus client that opens it</div>
      {error && <div className="us-inline-error">{error}</div>}
    </div>
  );
}
