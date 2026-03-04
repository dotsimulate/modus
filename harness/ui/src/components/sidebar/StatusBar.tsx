import type { UserProfile } from "../../api";

type Props = {
  harnessUp: boolean | null;
  userName?: string | null;
  onLock?: () => void;
  userProfiles?: UserProfile[];
  activeUserProfile?: string | null;
  onSwitchUserProfile?: (name: string | null) => void;
};

export function StatusBar({
  harnessUp, userName, onLock,
  userProfiles, activeUserProfile, onSwitchUserProfile,
}: Props) {
  return (
    <div className="harness-status">
      <div className="harness-status-left">
        <div
          className={`status-dot ${harnessUp === true ? "connected" : harnessUp === false ? "error" : ""}`}
        />
        {userProfiles && userProfiles.length > 0 && onSwitchUserProfile ? (
          <select
            className="user-profile-select"
            value={activeUserProfile ?? ""}
            onChange={(e) => onSwitchUserProfile(e.target.value || null)}
          >
            <option value="">all projects</option>
            {userProfiles.map((up) => (
              <option key={up.name} value={up.name}>{up.displayName ?? up.name}</option>
            ))}
          </select>
        ) : (
          <span>
            {harnessUp === true
              ? "harness connected"
              : harnessUp === false
                ? "harness offline"
                : "checking..."}
          </span>
        )}
      </div>
      <div className="harness-status-right">
        {userName && (
          <span className="harness-user">{userName}</span>
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
    </div>
  );
}
