/**
 * ProjectSetup — guided setup flow for new projects.
 *
 * Replaces the old onboarding checklist. Two phases:
 * 1. Create project (user profile): name, path, memory choice
 * 2. Set up agents: free-form prompt → modus-dev agent creates profiles
 *
 * Standalone component, not a widget — needs to work before any project exists.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import {
  saveUserProfileApi, createSession,
  fetchSessionStatus, fetchSessions, browsePath,
} from "../api";
import type { BrowseResult } from "../api";

type Phase = "project" | "agents" | "running" | "done" | "error";

type Props = {
  /** If set, skip project creation and go straight to agent setup */
  existingProject?: string;
  onComplete: () => void;
};

export function ProjectSetup({ existingProject, onComplete }: Props) {
  const {
    switchUserProfile, refreshProfiles, refreshUserProfiles, activeUP,
  } = useProfiles();

  const [phase, setPhase] = useState<Phase>(existingProject ? "agents" : "project");

  // ── Project form ──
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [creating, setCreating] = useState(false);

  // ── Path browser ──
  const [showBrowser, setShowBrowser] = useState(false);
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browsePath_input, setBrowsePathInput] = useState("");

  // ── Agent setup ──
  const [agentPrompt, setAgentPrompt] = useState("");
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const pollRef = useRef(false);

  const slug = projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const activeSlug = existingProject ?? slug;

  // ── Path browser helpers ──

  const browseNav = useCallback(async (path?: string) => {
    setBrowseLoading(true);
    try {
      const result = await browsePath(path);
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

  // ── Create project ──

  const createProject = useCallback(async () => {
    if (!slug || !projectPath.trim()) return;
    setCreating(true);
    try {
      await saveUserProfileApi(slug, {
        displayName: projectName,
        projects: [projectPath.trim()],
        agentProfiles: [],
        ...(useMemory ? {} : { memory: { scope: "global" as const, inheritGlobal: false } }),
      });
      switchUserProfile(slug);
      await refreshUserProfiles();
      setPhase("agents");
    } catch (err) {
      setError(`Failed to create project: ${err}`);
      setPhase("error");
    }
    setCreating(false);
  }, [slug, projectName, projectPath, useMemory, switchUserProfile, refreshUserProfiles]);

  // ── Run modus-dev agent ──

  const runSetup = useCallback(async () => {
    const prompt = agentPrompt.trim();
    if (!prompt) return;

    const userDisplay = activeUP?.displayName ?? projectName;
    const paths = activeUP?.projects ?? [projectPath];

    const structuredPrompt = [
      `## Setup Request`,
      ``,
      `Create agent profile(s) for this user based on their description.`,
      ``,
      `### User`,
      `- Name: ${userDisplay}`,
      `- Profile slug: ${activeSlug}`,
      `- Project paths: ${paths.join(", ")}`,
      ``,
      `### What they want`,
      prompt,
      ``,
      `### Tasks`,
      `1. Read the create-profile skill for the full schema`,
      `2. Create 1-2 agent profile(s) in profiles/agents/<name>.json`,
      `   - Write specific, directive prompts (not generic placeholders)`,
      `   - Use {{name}} to reference the user in prompts`,
      `   - Match tools list to the agent's purpose`,
      `3. Update profiles/users/${activeSlug}.json:`,
      `   - Add new agent profile names to the agentProfiles array`,
      `   - Keep all existing fields intact (use Edit, not Write)`,
      `4. List what you created`,
      ``,
      `### Rules`,
      `- The user profile already exists — update it, don't recreate`,
      `- Use permissionPolicy: "bypass" unless restrictions are requested`,
      `- Omit optional fields that use defaults — keep JSON clean`,
      `- Agent prompts: 2-6 sentences, dense and directive`,
    ].join("\n");

    setPhase("running");
    setStatusText("starting setup agent...");
    pollRef.current = true;

    try {
      const { sessionId: initialId } = await createSession({
        prompt: structuredPrompt,
        profile: "modus-dev",
      });

      // Resolve real session ID (backend rekeys ses-* temp IDs to UUIDs)
      let sid = initialId;
      if (sid.startsWith("ses-")) {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            const sessions = await fetchSessions(1);
            if (sessions.length > 0 && !sessions[0].id.startsWith("ses-")) {
              sid = sessions[0].id;
              break;
            }
          } catch { /* keep trying */ }
        }
      }

      // Poll until done
      for (let i = 0; i < 120 && pollRef.current; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const status = await fetchSessionStatus(sid);
          if (status.status === "idle") {
            setStatusText("setup complete");
            await Promise.all([refreshProfiles(), refreshUserProfiles()]);
            setPhase("done");
            return;
          }
          if (status.status === "error") {
            setError(status.error || "Agent encountered an error");
            setPhase("error");
            return;
          }
          const turns = status.numTurns ?? 0;
          setStatusText(turns > 0 ? `agent working... (${turns} turn${turns !== 1 ? "s" : ""})` : "agent working...");
        } catch { /* keep polling */ }
      }
      if (pollRef.current) {
        setError("Setup timed out");
        setPhase("error");
      }
    } catch (err) {
      setError(`Failed to start setup: ${err}`);
      setPhase("error");
    }
  }, [agentPrompt, projectName, projectPath, activeSlug, activeUP, refreshProfiles, refreshUserProfiles]);

  // Cleanup polling on unmount
  useEffect(() => () => { pollRef.current = false; }, []);

  // ── Skip agent setup ──

  const skipAgents = useCallback(() => {
    onComplete();
  }, [onComplete]);

  // ── Render ──

  if (phase === "project") {
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
            {useMemory
              ? "agent remembers across sessions"
              : "no persistent memory"}
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

  if (phase === "agents") {
    return (
      <div className="project-setup">
        <div className="setup-phase-title">set up agents</div>
        <p className="setup-description">
          describe what you want your agents to do. MO will create
          agent profiles tailored to your project.
        </p>

        <textarea
          className="setup-textarea"
          value={agentPrompt}
          onChange={(e) => setAgentPrompt(e.target.value)}
          placeholder={"a coding assistant for my TypeScript project,\nplus a research agent for looking things up"}
          rows={4}
          autoFocus
        />

        <div className="setup-actions">
          <button
            className="setup-action-btn"
            onClick={runSetup}
            disabled={!agentPrompt.trim()}
          >
            set up
          </button>
          <button className="setup-link-btn" onClick={skipAgents}>
            skip for now
          </button>
        </div>
      </div>
    );
  }

  if (phase === "running") {
    return (
      <div className="project-setup">
        <div className="setup-phase-title">setting up</div>
        <div className="setup-status">{statusText}</div>
        <div className="setup-progress-bar">
          <div className="setup-progress-fill" />
        </div>
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="project-setup">
        <div className="setup-phase-title">ready</div>
        <p className="setup-description">
          your project is configured. start a session to begin working.
        </p>
        <div className="setup-actions">
          <button className="setup-action-btn" onClick={onComplete}>
            done
          </button>
        </div>
      </div>
    );
  }

  // Error phase
  return (
    <div className="project-setup">
      <div className="setup-phase-title">error</div>
      <div className="setup-error">{error}</div>
      <div className="setup-actions">
        <button
          className="setup-action-btn"
          onClick={() => {
            setError("");
            setPhase(existingProject ? "agents" : "project");
          }}
        >
          try again
        </button>
      </div>
    </div>
  );
}
