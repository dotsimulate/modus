/**
 * ProjectSetup — project creation form.
 *
 * Only handles creating a new project (user profile + .modus/ scaffold).
 * Agent setup is handled by ModusPrompt via prompt presets after the
 * project exists.
 */

import { useState, useCallback } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { modus } from "../modusClient";
import type { BrowseResult } from "../../../sdk/index";

type Props = {
  onComplete: () => void;
  onSelectSession?: (id: string) => void;
};

export function ProjectSetup({ onComplete }: Props) {
  const { switchUserProfile, refreshProfiles, refreshUserProfiles } = useProfiles();

  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Path browser
  const [showBrowser, setShowBrowser] = useState(false);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browsePath_input, setBrowsePathInput] = useState("");

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const browseNav = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    try {
      const result = await modus.browse(path);
      setBrowseResult(result);
      setBrowsePathInput(result.path);
    } catch { /* silent */ }
    setBrowseLoading(false);
  }, []);

  const openBrowser = useCallback(() => {
    setShowBrowser(true);
    browseNav(projectPath || undefined);
  }, [projectPath, browseNav]);

  const selectBrowsedPath = useCallback((path: string) => {
    setProjectPath(path);
    setShowBrowser(false);
  }, []);

  const createProject = useCallback(async () => {
    if (!slug || !projectPath.trim()) return;
    setCreating(true);
    try {
      await modus.saveUserProfile(slug, {
        displayName: projectName,
        projects: [projectPath.trim()],
        agentProfiles: [],
        ...(useMemory ? {} : { memory: { scope: "global" as const, inheritGlobal: false } }),
      });
      await modus.initProject(projectPath.trim(), projectName);
      switchUserProfile(slug);
      await Promise.all([refreshUserProfiles(), refreshProfiles()]);
      onComplete();
    } catch (err) {
      setError(`Failed to create project: ${err}`);
    }
    setCreating(false);
  }, [slug, projectName, projectPath, useMemory, switchUserProfile, refreshUserProfiles, onComplete]);

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
          <button className="setup-browse-btn" onClick={openBrowser}>
            browse
          </button>
        </div>
      </label>

      {showBrowser && (
        <div className="setup-browser">
          <div className="setup-browser-pathbar">
            <input
              className="setup-input"
              value={browsePath_input}
              onChange={(e) => setBrowsePathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && browseNav(browsePath_input)}
              spellCheck={false}
            />
          </div>
          <div className="setup-browser-list">
            {browseLoading && <span className="setup-dim">loading...</span>}
            {!browseLoading && browseResult && (
              <>
                {browseResult.parent && (
                  <button
                    className="setup-browser-item"
                    onClick={() => browseNav(browseResult.parent!)}
                  >..</button>
                )}
                {browseResult.dirs.map((dir) => (
                  <button
                    key={dir}
                    className="setup-browser-item"
                    onClick={() => browseNav(`${browseResult.path}/${dir}`)}
                  >{dir}</button>
                ))}
              </>
            )}
          </div>
          {browseResult && (
            <div className="setup-browser-actions">
              <button
                className="setup-action-btn"
                onClick={() => selectBrowsedPath(browseResult.path)}
              >select {browseResult.path.split("/").pop() || "/"}</button>
              <button
                className="setup-link-btn"
                onClick={() => setShowBrowser(false)}
              >cancel</button>
            </div>
          )}
        </div>
      )}

      <label className="setup-field setup-field--toggle">
        <span className="setup-label">memory system</span>
        <button
          className={`setup-toggle ${useMemory ? "setup-toggle--on" : ""}`}
          onClick={() => setUseMemory(!useMemory)}
        >
          {useMemory ? "on" : "off"}
        </button>
        <span className="setup-hint">
          {useMemory ? "agent remembers across sessions" : "no persistent memory"}
        </span>
      </label>

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
