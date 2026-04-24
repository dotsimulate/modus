import { useEffect } from "react";
import { modus } from "../modusClient";
import { loadClientExtensions, unloadClientExtensions } from "../client-extensions";
import { useProfiles } from "../providers/ProfileContext";

export function ClientExtensionsBoot() {
  const { activeCwd, activeUserProfile } = useProfiles();
  const extCwd = activeCwd;

  useEffect(() => {
    let cancelled = false;

    modus.listClientExtensions(extCwd, activeUserProfile)
      .then((items) => {
        if (cancelled) return;
        return loadClientExtensions(items);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void unloadClientExtensions();
    };
  }, [extCwd, activeUserProfile]);

  return null;
}
