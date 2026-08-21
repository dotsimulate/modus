/**
 * ProjectSetup — project creation form.
 *
 * Only handles creating a new project (user profile + .modus/ scaffold).
 * Agent setup is handled by ModusPrompt via prompt presets after the
 * project exists.
 */

import { useState, useCallback } from "react";
import { useProfiles } from "../providers/ProfileContext";
import { modus } from "../modusClient";
import { LAUNCH_CWD } from "../launchParams";
import { backendStorageKey } from "../backendTarget";
import { useFolderChooser } from "../hooks/usePathChooser";

type Props = {
  onComplete: () => void;
  onSelectSession?: (id: string) => void;
};

export function ProjectSetup({ onComplete }: Props) {
  const { switchUserProfile, refreshProfiles, refreshUserProfiles } = useProfiles();

  const [projectName, setProjectName] = useState(
    () => LAUNCH_CWD ? LAUNCH_CWD.split("/").filter(Boolean).pop() ?? "" : "",
  );
  const [projectPath, setProjectPath] = useState(LAUNCH_CWD);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const folder = useFolderChooser();

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const openBrowser = useCallback(() => {
    folder.open({
      title: "Choose the project folder",
      initialPath: projectPath || undefined,
      onSelect: setProjectPath,
    });
  }, [folder.open, projectPath]);

  const createProject = useCallback(async () => {
    if (!slug || !projectPath.trim()) return;
    setCreating(true);
    try {
      await modus.saveUserProfile(slug, {
        displayName: projectName,
        projects: [projectPath.trim()],
        agentProfiles: ["modus-helper"],
        defaultAgentProfile: "modus-helper",
      });
      await modus.initProject(projectPath.trim(), projectName);
      sessionStorage.removeItem(backendStorageKey("modus:launch-cwd"));
      switchUserProfile(slug);
      await Promise.all([refreshUserProfiles(), refreshProfiles()]);
      onComplete();
    } catch (err) {
      setError(`Failed to create project: ${err}`);
    }
    setCreating(false);
  }, [slug, projectName, projectPath, switchUserProfile, refreshUserProfiles, onComplete]);

  if (error) {
    return (
      <div className="project-setup">
        <div className="setup-phase-title">error</div>
        <div className="setup-error">{error}</div>
        <div className="setup-actions">
          <button className="setup-action-btn" onClick={() => setError("")}>
            try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="project-setup">
      <div className="setup-phase-title">new project</div>

      <label className="setup-field">
        <span className="setup-label">name</span>
        <input
          className="setup-input"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="my project"
          autoFocus
        />
        {slug && <span className="setup-hint">{slug}</span>}
      </label>

      <label className="setup-field">
        <span className="setup-label">project path</span>
        <div className="setup-path-row">
          <input
            className="setup-input setup-input--path"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="/home/user/project"
            onKeyDown={(e) => e.key === "Enter" && createProject()}
          />
          <button className="setup-browse-btn" onClick={openBrowser} disabled={folder.busy}>
            browse
          </button>
        </div>
      </label>

      {folder.inline && <div className="setup-browser">{folder.inline}</div>}

      <div className="setup-actions">
        <button
          className="setup-action-btn"
          onClick={createProject}
          disabled={!slug || !projectPath.trim() || creating}
        >
          {creating ? "creating..." : "create project"}
        </button>
      </div>
    </div>
  );
}
