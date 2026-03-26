import { useEffect } from "react";
import { modus } from "../modusClient";
import { loadClientExtensions, unloadClientExtensions } from "../client-extensions";
import { useProfiles } from "../providers/ProfileProvider";

export function ClientExtensionsBoot() {
  const { activeCwd, projectRoot, activeUserProfile } = useProfiles();
  const extCwd = projectRoot ?? activeCwd;

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
