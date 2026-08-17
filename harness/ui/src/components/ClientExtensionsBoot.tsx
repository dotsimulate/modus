import { useEffect } from "react";
import { modus } from "../modusClient";
import { loadClientExtensions, unloadClientExtensions } from "../client-extensions";
import { refreshBackendClientExtensions } from "../client-extension-policy";
import { BACKEND_TARGET } from "../backendTarget";
import { isTauriRuntime } from "../desktopBridge";
import { reportClientTiming } from "../client-timing";
import { useProfiles } from "../providers/ProfileContext";

export function ClientExtensionsBoot() {
  const { activeCwd, projectRoot, activeUserProfile } = useProfiles();
  // Profile-level CWD overrides can settle after the project itself. Extensions
  // are project-scoped, so key their lifecycle to the stable root and use the
  // active CWD only when no configured project contains it.
  const extCwd = projectRoot || activeCwd;

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();

    refreshBackendClientExtensions({
      targetMode: BACKEND_TARGET.mode,
      nativeDesktop: isTauriRuntime(),
      list: () => modus.listClientExtensions(extCwd, activeUserProfile),
      // The swap inside loadClientExtensions keeps the current set live until
      // the new one is ready, so this cleanup only cancels — an unload here
      // would blank the composer's extensions on every settle step of a
      // project switch, which is exactly the gap users see.
      load: (items) => loadClientExtensions(items, { isCancelled: () => cancelled }),
      unload: unloadClientExtensions,
      cancelled: () => cancelled,
    })
      .then((outcome) => {
        reportClientTiming("clientExtensions", performance.now() - t0, { outcome, cwd: extCwd ?? "" });
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [extCwd, activeUserProfile]);

  return null;
}
