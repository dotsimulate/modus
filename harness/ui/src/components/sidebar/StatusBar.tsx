import { useState, useRef, useEffect } from "react";
import type { UserProfile } from "../../api";

type Props = {
  harnessUp: boolean | null;
  onLock?: () => void;
  userProfiles?: UserProfile[];
  activeUserProfile?: string | null;
  onSwitchUserProfile?: (name: string | null) => void;
  onNewProfile?: () => void;
  onUserSettings?: () => void;
  computer?: string;
  projectPath?: string;
};

export function StatusBar({
  harnessUp, onLock,
  userProfiles, activeUserProfile, onSwitchUserProfile, onNewProfile, onUserSettings,
  computer, projectPath,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const hasProfiles = userProfiles && userProfiles.length > 0 && onSwitchUserProfile;
  const activeUp = userProfiles?.find((p) => p.name === activeUserProfile);
  const label = activeUp?.displayName ?? activeUp?.name ?? "all";

  const folderName = projectPath ? projectPath.split("/").filter(Boolean).pop() : undefined;

  return (
    <div className="harness-status">
      {(computer || folderName) && (
        <span className="status-computer-info">
          {computer && <span>{computer}</span>}
          {computer && folderName && <span className="status-sep">·</span>}
          {folderName && <span className="status-path">{folderName}</span>}
        </span>
      )}
      <div
        className={`status-dot ${harnessUp === true ? "connected" : harnessUp === false ? "error" : ""}`}
      />
      {hasProfiles ? (
        <div className="profile-switcher" ref={wrapRef}>
          <button
            className="profile-switcher-btn"
            onClick={() => setMenuOpen((o) => !o)}
          >
            {label}
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {menuOpen && (
            <div className="profile-switcher-menu">
              <button
                className={`profile-switcher-item${!activeUserProfile ? " active" : ""}`}
                onClick={() => { onSwitchUserProfile!(null); setMenuOpen(false); }}
              >
                all projects
              </button>
              {userProfiles!.map((up) => (
                <button
                  key={up.name}
                  className={`profile-switcher-item${activeUserProfile === up.name ? " active" : ""}`}
                  onClick={() => { onSwitchUserProfile!(up.name); setMenuOpen(false); }}
                >
                  {up.displayName ?? up.name}
                </button>
              ))}
              <div className="profile-switcher-divider" />
              <button
                className="profile-switcher-item profile-switcher-new"
                onClick={() => { setMenuOpen(false); onNewProfile?.(); }}
              >
                + new project
              </button>
              <div className="profile-switcher-divider" />
              <button
                className="profile-switcher-item"
                onClick={() => { setMenuOpen(false); onUserSettings?.(); }}
              >
                user settings
              </button>
            </div>
          )}
        </div>
      ) : (
        <span>
          {harnessUp === true
            ? "connected"
            : harnessUp === false
              ? "offline"
              : "..."}
        </span>
      )}
      {onLock && (
        <button className="lock-btn" onClick={onLock} title="Lock">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="2" y="5" width="8" height="6" rx="1" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M4 5V3.5a2 2 0 0 1 4 0V5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      )}
    </div>
  );
}
