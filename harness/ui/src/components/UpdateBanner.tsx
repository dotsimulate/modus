import { useEffect, useMemo, useState } from "react";
import {
  checkForDesktopUpdate,
  getDesktopUpdateState,
  installCheckedDesktopUpdate,
  subscribeDesktopUpdateState,
} from "../desktop-update-service";
import { isTauriRuntime } from "../desktopBridge";
import {
  automaticUpdateChecksEnabled,
  parseUpdateUrgency,
  shouldCheckForUpdates,
} from "../update-policy";

export function UpdateBanner() {
  const [state, setState] = useState(getDesktopUpdateState);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const urgency = useMemo(() => parseUpdateUrgency(state.update?.notes), [state.update?.notes]);

  useEffect(() => subscribeDesktopUpdateState(setState), []);
  useEffect(() => {
    if (shouldCheckForUpdates({
      nativeDesktop: isTauriRuntime(),
      enabled: automaticUpdateChecksEnabled(),
    })) void checkForDesktopUpdate();
  }, []);

  if (state.status === "installing") {
    return <div className="update-banner recommended">Downloading and installing the confirmed update…</div>;
  }
  if (state.status !== "available" || !state.update?.version || dismissedVersion === state.update.version) return null;

  const install = async () => {
    const confirmed = window.confirm(`Install Modus ${state.update?.version}? Modus will stop its managed backend and restart. Active agent work will not be replayed automatically.`);
    if (confirmed) await installCheckedDesktopUpdate();
  };

  return (
    <div className={`update-banner ${urgency}`}>
      <div>
        <strong>Modus {state.update.version} is available</strong>
        <span>{urgency === "critical" ? "Critical security update" : urgency === "recommended" ? "Recommended update" : "Optional update"}</span>
      </div>
      <div className="update-banner-actions">
        <button type="button" onClick={() => void install()}>Download and install</button>
        <button type="button" onClick={() => setDismissedVersion(state.update?.version ?? null)}>Later</button>
      </div>
    </div>
  );
}

