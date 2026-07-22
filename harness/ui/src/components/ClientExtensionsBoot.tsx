import { useEffect } from "react";
import { modus } from "../modusClient";
import { loadClientExtensions, unloadClientExtensions } from "../client-extensions";
import { refreshBackendClientExtensions } from "../client-extension-policy";
import { BACKEND_TARGET } from "../backendTarget";
import { isTauriRuntime } from "../desktopBridge";
import { useProfiles } from "../providers/ProfileContext";

export function ClientExtensionsBoot() {
  const { activeCwd, activeUserProfile } = useProfiles();
  const extCwd = activeCwd;

  useEffect(() => {
    let cancelled = false;

    refreshBackendClientExtensions({
      targetMode: BACKEND_TARGET.mode,
      nativeDesktop: isTauriRuntime(),
      list: () => modus.listClientExtensions(extCwd, activeUserProfile),
      load: loadClientExtensions,
      unload: unloadClientExtensions,
      cancelled: () => cancelled,
    })
      .catch(() => {});

    return () => {
      cancelled = true;
      void unloadClientExtensions();
    };
  }, [extCwd, activeUserProfile]);

  return null;
}
