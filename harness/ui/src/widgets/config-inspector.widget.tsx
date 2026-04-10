/**
 * Config Inspector widget — shows the resolved configuration cascade
 * for the active session.
 *
 * Each config value is tagged with its origin in the cascade:
 *   profile → user → session → default
 *
 * Best placed in the left panel so users can see what's active while chatting.
 *
 * Config example:
 *   { "id": "config-inspector-left", "type": "config-inspector" }
 */

import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { WidgetEmptyState } from "./widget-components";

// ── Types ──

type Origin = "profile" | "user" | "session" | "default";

// ── Helpers ──

function shortModel(model?: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/-\d{8}.*/, "");
}

function resolveOrigin(
  effective: string | undefined,
  profileVal: string | undefined,
  userVal: string | undefined,
): Origin {
  if (!effective) return "default";
  if (profileVal && effective === profileVal) return "profile";
  if (userVal && effective === userVal && effective !== profileVal) return "user";
  if (effective !== profileVal && effective !== userVal) return "session";
  return "profile";
}

function toolsSummary(tools?: string[] | "all", availableTools?: string[]): string {
  if (availableTools && availableTools.length > 0) {
    return String(availableTools.length);
  }
  if (!tools || tools === "all") return "all";
  return String(tools.length);
}

// ── Component ──

export default function ConfigInspectorWidget() {
  const { activeSession, serverSessions } = useSession();
  const { profiles, activeUP, selectedProfile } = useProfiles();

  if (!activeSession || activeSession.id.startsWith("pending-")) {
    return <WidgetEmptyState>no active session</WidgetEmptyState>;
  }

  const activeProfileName = activeSession.profile ?? selectedProfile;
  const profileData = profiles.find(p => p.name === activeProfileName);
  const activeSessionInfo = serverSessions.find(s => s.id === activeSession.id);

  // Resolve effective values through the cascade
  const provider =
    activeSession.agentConfig?.provider ||
    activeSessionInfo?.provider ||
    activeSession.provider ||
    profileData?.provider ||
    activeUP?.provider ||
    "claude-code";

  const model =
    activeSession.agentConfig?.model ||
    activeSession.model ||
    profileData?.model ||
    activeUP?.model ||
    "";

  const effort =
    activeSession.agentConfig?.effort ||
    profileData?.effort ||
    activeUP?.effort ||
    "";

  // Determine origins
  const sessionConfigProvider = activeSession.agentConfig?.provider;
  const sessionConfigModel = activeSession.agentConfig?.model;
  const sessionConfigEffort = activeSession.agentConfig?.effort;

  const providerOrigin: Origin = sessionConfigProvider
    ? "session"
    : resolveOrigin(provider, profileData?.provider, activeUP?.provider);

  const modelOrigin: Origin = sessionConfigModel
    ? "session"
    : resolveOrigin(model, profileData?.model, activeUP?.model);

  const effortOrigin: Origin = sessionConfigEffort
    ? "session"
    : resolveOrigin(effort, profileData?.effort, activeUP?.effort);

  // Tool and MCP info
  const availableTools = activeSession.availableTools;
  const profileTools = profileData?.tools;
  const mcpCount = profileData?.mcpServers ? Object.keys(profileData.mcpServers).length : 0;

  // Build rows: [label, value, origin | null]
  const rows: [string, string, Origin | null][] = [];
  if (activeProfileName) rows.push(["profile", activeProfileName, "profile"]);
  rows.push(["provider", provider, providerOrigin]);
  if (model) rows.push(["model", shortModel(model), modelOrigin]);
  if (effort) rows.push(["effort", effort, effortOrigin]);
  rows.push(["tools", toolsSummary(profileTools, availableTools), null]);
  if (mcpCount > 0) rows.push(["mcp", `${mcpCount} server${mcpCount !== 1 ? "s" : ""}`, null]);

  return (
    <div className="ciw-widget">
      {rows.map(([label, value, origin]) => (
        <div key={label} className="ciw-row">
          <span className="ciw-label">{label}</span>
          <span className="ciw-value">{value}</span>
          {origin && <span className={`ciw-origin ciw-origin--${origin}`}>{origin}</span>}
        </div>
      ))}
    </div>
  );
}

