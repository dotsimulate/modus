import { useCallback } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { normalizePageNavPrefs, type PageNavPrefs } from "../pageNav";

export function usePageNavPrefs() {
  const { activeUserProfile, activeUP, refreshUserProfiles } = useProfiles();
  const prefs = normalizePageNavPrefs(activeUP?.pageNav);

  const savePrefs = useCallback(async (next: PageNavPrefs) => {
    if (!activeUserProfile) return;
    await modus.patchUserProfileUiConfig(activeUserProfile, { pageNav: normalizePageNavPrefs(next) });
    await refreshUserProfiles();
  }, [activeUserProfile, refreshUserProfiles]);

  return {
    prefs,
    canSave: Boolean(activeUserProfile),
    savePrefs,
  };
}
