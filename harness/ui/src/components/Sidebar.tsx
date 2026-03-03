import { useState } from "react";
import type { Profile, SessionInfo } from "../api";
import { SessionSetup, type SessionSetupState } from "./SessionSetup";

type Props = {
  open: boolean;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  profiles: Profile[];
  selectedProfile: string;
  harnessUp: boolean | null;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onSelectProfile: (name: string) => void;
  onSetupChange: (setup: SessionSetupState) => void;
  setupState: SessionSetupState;
  onClose: () => void;
};

/** Detect which categories have overrides vs profile defaults */
function getOverrideTags(setup: SessionSetupState): string[] {
  const tags: string[] = [];
  if (setup.model) tags.push("model");
  if (setup.cwd.trim()) tags.push("cwd");
  if (setup.agent.effort) tags.push("effort");
  if (setup.agent.maxTurns) tags.push("turns");
  const toolOverrides = Object.keys(setup.agent.toolStates).length;
  if (toolOverrides > 0) tags.push(`${toolOverrides} tools`);
  if (!setup.loadProjectSettings) tags.push("no claude.md");
  return tags;
}

export function Sidebar({
  open,
  sessions,
  activeSessionId,
  profiles,
  selectedProfile,
  harnessUp,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  onSelectProfile,
  onSetupChange,
  setupState,
  onClose,
}: Props) {
  const [configExpanded, setConfigExpanded] = useState(false);
  const selectedProfileData = profiles.find((p) => p.name === selectedProfile);
  const overrideTags = getOverrideTags(setupState);

  function timeAgo(ts: number): string {
    const diff = Date.now() - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function groupSessions(list: SessionInfo[]) {
    const now = Date.now();
    const today: SessionInfo[] = [];
    const yesterday: SessionInfo[] = [];
    const thisWeek: SessionInfo[] = [];
    const older: SessionInfo[] = [];

    for (const s of list) {
      const age = now - s.updated_at;
      if (age < 86_400_000) today.push(s);
      else if (age < 172_800_000) yesterday.push(s);
      else if (age < 604_800_000) thisWeek.push(s);
      else older.push(s);
    }

    return [
      { label: "today", items: today },
      { label: "yesterday", items: yesterday },
      { label: "this week", items: thisWeek },
      { label: "older", items: older },
    ].filter((g) => g.items.length > 0);
  }

  function statusIcon(status: string) {
    if (status === "running" || status === "idle") return <span className="session-running-dot" />;
    if (status === "error") return <span className="session-error-dot" />;
    if (status === "done") return <span className="session-done-dot" />;
    return null;
  }

  const groups = groupSessions(sessions);

  // Profile summary line
  const profileSummary = selectedProfileData
    ? `${selectedProfileData.model.replace("claude-", "").replace(/-\d.*/, "")} / ${selectedProfileData.effort ?? "default"} / ${
        typeof selectedProfileData.tools === "string"
          ? selectedProfileData.tools
          : selectedProfileData.tools.length + " tools"
      }`
    : "";

  return (
    <>
      {open && <div className="sidebar-overlay" onClick={onClose} />}
      <div className={`sidebar ${open ? "open" : ""}`}>
        <div className="sidebar-header">
          <div className="sidebar-title">agent</div>
          <button className="new-session-btn" onClick={onNewSession}>
            new session
          </button>
        </div>

        <div className="sidebar-sections">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="sidebar-section-label">{group.label}</div>
              {group.items.map((s) => (
                <div
                  key={s.id}
                  className={`session-item ${s.id === activeSessionId ? "active" : ""}`}
                  onClick={() => onSelectSession(s.id)}
                >
                  <div className="session-item-preview">
                    {statusIcon(s.status)}
                    <span className="session-item-text">{s.last_prompt ?? s.preview}</span>
                  </div>
                  <div className="session-item-meta">
                    <span className="session-profile-tag">
                      {s.profile ?? "default"}
                    </span>
                    <span>${s.total_cost_usd.toFixed(3)}</span>
                    <span>{timeAgo(s.updated_at)}</span>
                    <button
                      className="session-delete-btn"
                      onClick={(e) => { e.stopPropagation(); onDeleteSession(s.id); }}
                      title="Delete session"
                    >
                      &times;
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── Collapsible profile + config panel ── */}
        <div className="profile-panel">
          <button
            className="profile-panel-header"
            onClick={() => setConfigExpanded(!configExpanded)}
          >
            <div className="profile-panel-left">
              <span className="profile-panel-name">{selectedProfile}</span>
              <span className="profile-panel-summary">{profileSummary}</span>
            </div>
            <div className="profile-panel-right">
              {overrideTags.length > 0 && (
                <span className="profile-panel-overrides">
                  {overrideTags.map((t) => (
                    <span key={t} className="override-tag">{t}*</span>
                  ))}
                </span>
              )}
              <span className="profile-panel-chevron">{configExpanded ? "−" : "+"}</span>
            </div>
          </button>

          <div className={`panel-collapse ${configExpanded ? "panel-collapse--open" : ""}`}>
            <div className="profile-panel-body">
              {/* Profile selector */}
              <label className="agent-config-field">
                <span>profile</span>
                <select
                  value={selectedProfile}
                  onChange={(e) => onSelectProfile(e.target.value)}
                >
                  {profiles.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </label>

              {/* Full session setup */}
              <SessionSetup
                config={setupState}
                profileTools={selectedProfileData?.tools ?? "all"}
                profileEffort={selectedProfileData?.effort}
                profileMaxTurns={selectedProfileData?.maxTurns}
                profileModel={selectedProfileData?.model}
                onChange={onSetupChange}
              />
            </div>
          </div>
        </div>

        <div className="harness-status">
          <div
            className={`status-dot ${harnessUp === true ? "connected" : harnessUp === false ? "error" : ""}`}
          />
          <span>
            {harnessUp === true
              ? "harness connected"
              : harnessUp === false
                ? "harness offline"
                : "checking..."}
          </span>
        </div>
      </div>
    </>
  );
}
