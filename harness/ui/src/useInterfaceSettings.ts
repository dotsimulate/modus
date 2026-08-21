import { useEffect, useState } from "react";
import type { UserInterfaceConfig } from "../../sdk/index";
import {
  INTERFACE_SETTINGS_EVENT,
  resolveEffectiveInterfaceSettings,
  type ResolvedInterfaceSettings,
} from "./interface-settings";

/**
 * Resolved interface settings that follow live edits.
 *
 * Device defaults change immediately, while an enabled project override is
 * persisted to the user-profile UI sidecar. Reading the event and the profile
 * keeps both paths live without treating the profile as the default owner.
 */
export function useInterfaceSettings(
  config?: UserInterfaceConfig | null,
): ResolvedInterfaceSettings {
  const [settings, setSettings] = useState(() => resolveEffectiveInterfaceSettings(config));

  useEffect(() => {
    setSettings(resolveEffectiveInterfaceSettings(config));
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
