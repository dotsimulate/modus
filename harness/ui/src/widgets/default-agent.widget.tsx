/**
 * Default Agent widget — shows what configuration new sessions will use.
 *
 * Config example:
 *   { "id": "default-agent-main", "type": "default-agent", "title": "session defaults" }
 */

import { useProfiles } from "../providers/ProfileContext";
import type { WidgetDef } from "./types";
import { WidgetEmptyState } from "./widget-components";

function shortModel(model?: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/-\d{8}.*/, "");
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

export default function DefaultAgentWidget() {
  const { activeUP, selectedProfile, profiles, setupState } = useProfiles();

  if (!activeUP) {
    return <WidgetEmptyState>no user profile active</WidgetEmptyState>;
  }

  const defaultProfileName = activeUP.defaultAgentProfile || selectedProfile;
  const defaultProfile = profiles.find(p => p.name === defaultProfileName);
  const effectiveProvider = activeUP.provider || defaultProfile?.provider || "claude-code";
  const effectiveModel = activeUP.model || defaultProfile?.model || "";
  const effectiveEffort = activeUP.effort || defaultProfile?.effort || "";
  const cwd = setupState?.cwd || activeUP.projects?.[0] || "";

  const rows: [string, string][] = [];
  if (defaultProfileName) rows.push(["agent", defaultProfileName]);
  rows.push(["provider", effectiveProvider]);
  if (effectiveModel) rows.push(["model", shortModel(effectiveModel)]);
  if (effectiveEffort) rows.push(["effort", effectiveEffort]);
  if (cwd) rows.push(["cwd", basename(cwd)]);

  return (
    <div className="daw-widget">
      {rows.map(([label, value]) => (
        <div key={label} className="daw-row">
          <span className="daw-label">{label}</span>
          <span className="daw-value">{value}</span>
        </div>
      ))}
      {defaultProfileName && !defaultProfile && (
        <div className="daw-warn">profile "{defaultProfileName}" not found</div>
      )}
    </div>
  );
}
