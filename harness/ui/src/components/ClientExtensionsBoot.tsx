import { useEffect } from "react";
import { fetchClientExtensions } from "../api";
import { loadClientExtensions, unloadClientExtensions } from "../client-extensions";
import { useProfiles } from "../providers/ProfileProvider";

export function ClientExtensionsBoot() {
  const { activeCwd, activeUserProfile } = useProfiles();

  useEffect(() => {
    let cancelled = false;

    fetchClientExtensions(activeCwd, activeUserProfile)
      .then((items) => {
        if (cancelled) return;
        return loadClientExtensions(items);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      void unloadClientExtensions();
    };
  }, [activeCwd, activeUserProfile]);

  return null;
}
