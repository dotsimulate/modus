import { useEffect, useState } from "react";
import type { UserInterfaceConfig } from "../../sdk/index";
import {
  INTERFACE_SETTINGS_EVENT,
  resolveInterfaceSettings,
  type ResolvedInterfaceSettings,
} from "./interface-settings";

/**
 * Resolved interface settings that follow live edits.
 *
 * Both settings surfaces debounce their write to the user profile, so a
 * component reading only `activeUP.interface` lags a toggle by the save round
 * trip. The change event fires immediately; the profile value is what survives
 * a reload or a project switch. Reading both keeps a toggle instant without
 * letting the local copy outlive the profile it came from.
 */
export function useInterfaceSettings(
  config?: UserInterfaceConfig | null,
): ResolvedInterfaceSettings {
  const [settings, setSettings] = useState(() => resolveInterfaceSettings(config));

  useEffect(() => {
    setSettings(resolveInterfaceSettings(config));
  }, [config]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as ResolvedInterfaceSettings | undefined;
      if (detail?.configBar) setSettings(detail);
    };
    window.addEventListener(INTERFACE_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(INTERFACE_SETTINGS_EVENT, handler);
  }, []);

  return settings;
}
