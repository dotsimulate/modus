import { useState, useEffect } from "react";
import { fetchProfiles, fetchActiveSessions } from "../api";
import type { Profile, ActiveSessionInfo } from "../api";
import type { View } from "../views";
import { useProfiles } from "../providers/ProfileProvider";
import { useSession } from "../providers/SessionProvider";
import { SessionsPanel } from "./SessionsPanel";
import { ProfileEditor } from "./ProfileEditor";

type Props = {
  onSelectSession: (id: string) => void;
  onNavigate: (view: View) => void;
};

function shortModel(model?: string): string {
  if (!model) return "default";
  return model.replace("claude-", "").replace(/-\d{8}.*/, "");
}

function toolsSummary(tools?: string[] | "all"): string {
  if (!tools || tools === "all") return "all";
  return String(tools.length);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

function ActiveSessionsPopover({
  sessions,
  onSelect,
}: {
  sessions: ActiveSessionInfo[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="apc-popover">
      {sessions.map((s) => (
        <button
          key={s.id}
          className={`apc-popover-item ${s.archived ? "apc-popover-item--archived" : ""}`}
          onClick={(e) => { e.stopPropagation(); onSelect(s.id); }}
        >
          <span className={`dash-dot ${s.archived ? "dash-dot--idle" : s.status === "running" ? "dash-dot--streaming" : "dash-dot--running"}`} />
          <span className="apc-popover-preview">{s.lastText || s.preview || "new session"}</span>
          <span className="apc-popover-meta">${s.costUsd.toFixed(2)}</span>
          <span className="apc-popover-meta">{timeAgo(s.lastEventAt)}</span>
        </button>
      ))}
    </div>
  );
}

const editIcon = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.5 1.5l2 2L4 10H2v-2z" />
  </svg>
);

export function Profiles({ onSelectSession, onNavigate }: Props) {
  const { visibleProfiles, selectProfile, activeUserProfile, activeCwd } = useProfiles();
  const { newSession } = useSession();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeSessions, setActiveSessions] = useState<ActiveSessionInfo[]>([]);
  const [editorMode, setEditorMode] = useState<"closed" | "new" | "edit">("closed");
  const [editingProfile, setEditingProfile] = useState<string | null>(null);
  const [hoveredBadge, setHoveredBadge] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, s] = await Promise.all([
          fetchProfiles(activeCwd),
          fetchActiveSessions(activeUserProfile ?? undefined),
        ]);
        setProfiles(p);
        setActiveSessions(s);
      } catch { /* silent */ }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [activeUserProfile]);

  const displayProfiles = visibleProfiles.length > 0 ? visibleProfiles : profiles;
  const isEditing = editorMode !== "closed";

  const getActiveSessionsForProfile = (name: string) =>
    activeSessions.filter((s) => s.profile === name);

  const openEdit = (name: string) => {
    setEditorMode("edit");
    setEditingProfile(name);
  };
  const openNew = () => {
    setEditorMode("new");
    setEditingProfile(null);
  };
  const closeEditor = () => {
    setEditorMode("closed");
    setEditingProfile(null);
  };

  const reloadProfiles = async () => {
    try { setProfiles(await fetchProfiles(activeCwd)); } catch { return; }
  };

  // Editor takes over the full view
  if (isEditing) {
    return (
      <div className="dashboard profiles-view">
        <ProfileEditor
          profiles={profiles}
          onProfilesChange={() => { reloadProfiles(); closeEditor(); }}
          mode={editorMode}
          initialProfile={editingProfile}
          onCancel={closeEditor}
        />
      </div>
    );
  }

  return (
    <div className="dashboard profiles-view">
      <div className="profiles-inner">
        <div className="dash-section">
          <div className="dash-section-header">
            <span className="dash-section-title">agents</span>
            <span className="dash-section-count">{displayProfiles.length}</span>
            <button className="dash-new-btn" onClick={openNew}>new</button>
          </div>
          <div className="agent-profile-grid">
            {displayProfiles.map((p) => {
              const profSessions = getActiveSessionsForProfile(p.name);
              return (
                <div key={p.name} className="agent-profile-card">
                  <div className="apc-row apc-row--header">
                    <span className="apc-name">{p.name}</span>
                    <button className="apc-edit-btn" title="edit" onClick={() => openEdit(p.name)}>
                      {editIcon}
                    </button>
                  </div>
                  <div className="apc-desc">{p.description}</div>
                  <div className="apc-row apc-row--stats">
                    <span className="apc-tag">{shortModel(p.model)}</span>
                    <span className="apc-tag">{p.effort ?? "default"}</span>
                    <span className="apc-tag">{toolsSummary(p.tools)} tools</span>
                    {p.mcpServers && Object.keys(p.mcpServers).length > 0 && (
                      <span className="apc-tag">{Object.keys(p.mcpServers).length} mcp</span>
                    )}
                  </div>
                  <div className="apc-row apc-row--actions">
                    <span
                      className={`apc-active-badge ${profSessions.length === 0 ? "apc-active-badge--zero" : ""}`}
                      onMouseEnter={() => profSessions.length > 0 && setHoveredBadge(p.name)}
                      onMouseLeave={() => setHoveredBadge(null)}
                    >
                      <span className={`dash-dot ${profSessions.length === 0 ? "dash-dot--idle" : profSessions.some((s) => s.status === "running" && !s.archived) ? "dash-dot--streaming" : "dash-dot--running"}`} />
                      {profSessions.length}
                      {hoveredBadge === p.name && profSessions.length > 0 && (
                        <ActiveSessionsPopover sessions={profSessions} onSelect={onSelectSession} />
                      )}
                    </span>
                    <span className="apc-actions-spacer" />
                    <button
                      className="apc-action apc-action--primary"
                      onClick={async () => {
                        selectProfile(p.name);
                        await newSession();
                        onNavigate("chat");
                      }}
                    >
                      new session
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="dash-section">
          <SessionsPanel onSelectSession={onSelectSession} />
        </div>
      </div>
    </div>
  );
}
