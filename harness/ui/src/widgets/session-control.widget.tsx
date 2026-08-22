/**
 * Session Control widget — provider, model, effort controls for the active session.
 *
 * Mirrors key ConfigBar controls in the LeftPanel widget slot.
 * Reads and writes through the same session state as ConfigBar.
 *
 * Config example:
 *   { "id": "session-control-left", "type": "session-control" }
 */

import { useActiveSessionId, useSessionActions } from "../providers/SessionContext";
import { useSessionState } from "../sessionStore";
import { useProfiles } from "../providers/ProfileContext";
import { SearchDropdown } from "../components/SearchDropdown";
import { WidgetEmptyState } from "./widget-components";

const EFFORT_OPTIONS = [
  { value: "" },
  { value: "low" },
  { value: "medium" },
  { value: "high" },
  { value: "xhigh" },
  { value: "max" },
];

export default function SessionControlWidget() {
  const activeSessionId = useActiveSessionId();
  const activeSession = useSessionState(activeSessionId);
  const { updateActiveSessionConfig } = useSessionActions();
  const { profiles, activeUP, selectedProfile } = useProfiles();

  if (!activeSession || activeSession.id.startsWith("pending-")) {
    return <WidgetEmptyState>no active session</WidgetEmptyState>;
  }

  const activeProfileName = activeSession.profile ?? selectedProfile;
  const profileData = profiles.find((p) => p.name === activeProfileName);

  const config = activeSession.nextAgentConfig ?? activeSession.agentConfig;
  const effectiveProvider = config.provider || profileData?.provider || activeUP?.provider || "";
  const effectiveModel = activeSession.model || profileData?.model || activeUP?.model || "";
  const effectiveEffort = config.effort || profileData?.effort || activeUP?.effort || "default";

  const update = (patch: Record<string, string>) => {
    updateActiveSessionConfig({ ...config, ...patch });
  };

  return (
    <div className="sc-widget">
      <div className="sc-field">
        <span className="sc-label">provider</span>
        <span className="sc-value">{effectiveProvider || "—"}</span>
      </div>

      <div className="sc-field">
        <span className="sc-label">model</span>
        <span className="sc-value">{effectiveModel.replace(/^.*\//, "").replace(/^claude-/, "") || "—"}</span>
      </div>

      <div className="sc-field">
        <span className="sc-label">effort</span>
        <SearchDropdown
          className="search-dropdown--compact sc-dropdown"
          value={config.effort || ""}
          options={EFFORT_OPTIONS}
          placeholder={effectiveEffort}
          searchPlaceholder="effort..."
          clearable
          onChange={(effort) => update({ effort })}
        />
      </div>
    </div>
  );
}
