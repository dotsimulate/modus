/**
 * Profile Card widget — compact view of the selected agent profile's config.
 *
 * Config example:
 *   { "id": "profile-card-left", "type": "profile-card" }
 *   { "id": "profile-card-custom", "type": "profile-card", "profileName": "dev-agent" }
 */

import { useProfiles } from "../providers/ProfileContext";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type ProfileCardConfig = WidgetBase & {
  type: "profile-card";
  profileName?: string;
};

function shortModel(model?: string): string {
  if (!model) return "default";
  return model.replace(/^claude-/, "").replace(/-\d{8}.*/, "");
}

export default function ProfileCardWidget({ config }: WidgetProps<ProfileCardConfig>) {
  const { profiles, selectedProfile } = useProfiles();
  const profileName = config.profileName ?? selectedProfile;
  const profile = profiles.find(p => p.name === profileName);

  if (!profileName) return <WidgetEmptyState>no profile selected</WidgetEmptyState>;
  if (!profile) return <WidgetEmptyState>profile not found: {profileName}</WidgetEmptyState>;

  const mcp = profile.mcpServers ? Object.keys(profile.mcpServers) : [];
  const tools = !profile.tools || profile.tools === "all" ? "all" : String(profile.tools.length);

  const rows: [string, string][] = [
    ["name", profile.name],
  ];
  if (profile.provider) rows.push(["provider", profile.provider]);
  if (profile.model) rows.push(["model", shortModel(profile.model)]);
  if (profile.effort) rows.push(["effort", profile.effort]);
  rows.push(["tools", tools]);
  if (mcp.length > 0) rows.push(["mcp", mcp.length <= 3 ? mcp.join(", ") : `${mcp.length} servers`]);
  if (profile.promptMode) rows.push(["prompt", profile.promptMode]);

  return (
    <div className="pcw-widget">
      {profile.description && (
        <div className="pcw-desc">{profile.description}</div>
      )}
      {rows.map(([label, value]) => (
        <div key={label} className="pcw-row">
          <span className="pcw-label">{label}</span>
          <span className="pcw-value">{value}</span>
        </div>
      ))}
    </div>
  );
}
