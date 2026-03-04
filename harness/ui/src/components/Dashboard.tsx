import { useState, useEffect } from "react";
import { fetchProfiles } from "../api";
import type { Profile } from "../api";
import { SessionsPanel } from "./SessionsPanel";
import { ProfileEditor } from "./ProfileEditor";

type Props = {
  onSelectSession: (id: string) => void;
  onBack: () => void;
};

export function Dashboard({ onSelectSession, onBack }: Props) {
  const [profiles, setProfiles] = useState<Profile[]>([]);

  const loadProfiles = async () => {
    try {
      setProfiles(await fetchProfiles());
    } catch { /* silent */ }
  };

  useEffect(() => { loadProfiles(); }, []);

  return (
    <div className="dashboard">
      <div className="dash-header">
        <button className="dash-back" onClick={onBack}>&larr; chat</button>
        <span className="dash-title">dashboard</span>
        <a className="dash-link" href="#memory">memory</a>
      </div>

      <div className="dash-panels">
        <SessionsPanel onSelectSession={onSelectSession} />
        <ProfileEditor profiles={profiles} onProfilesChange={loadProfiles} />
      </div>
    </div>
  );
}
