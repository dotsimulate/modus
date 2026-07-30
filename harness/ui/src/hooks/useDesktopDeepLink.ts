import { useEffect, useRef } from "react";
import {
  isTauriRuntime,
  onDesktopDeepLink,
  takePendingDeepLink,
  type DesktopDeepLinkTarget,
} from "../desktopBridge";
import { isSessionId } from "../sessionIds";

/**
 * Claim the parked cold-start link, at most once per page load.
 *
 * Claiming is destructive on the Rust side, and React StrictMode runs every
 * effect twice in development — so without this memo the first mount drains the
 * slot, its cleanup marks that result stale, and the second mount finds nothing.
 * That loses every cold-start link, in exactly the development build where the
 * `modus://` scheme is self-registered and therefore testable at all.
 */
let pendingClaim: Promise<DesktopDeepLinkTarget | null> | undefined;

function claimPendingDeepLink(): Promise<DesktopDeepLinkTarget | null> {
  // A desktop build too old to expose the command simply has no pending link.
  pendingClaim ??= takePendingDeepLink().catch(() => null);
  return pendingClaim;
}

/**
 * Rust already validated this, but it crossed an IPC boundary from a
 * machine-wide URL scheme, so it is re-checked before it can reach a route.
 * Mirrors `is_link_slug` in `deep_link.rs`: no separators, so neither segment
 * can forge a different view once one becomes `page:<slug>`.
 */
const LINK_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isUsableTarget(target: DesktopDeepLinkTarget | null): target is DesktopDeepLinkTarget {
  if (!target) return false;
  if (target.kind === "session") return isSessionId(target.sessionId);
  if (target.kind === "page") return LINK_SLUG.test(target.project) && LINK_SLUG.test(target.slug);
  return false;
}

/**
 * Report what a `modus://` link the OS handed us points at.
 *
 * A link names something that already exists and nothing more — a session, or
 * a page. It carries no project and no profile, so resolving *which* session or
 * page a name refers to is the caller's job; that is what keeps one link
 * resolving the same way for everyone instead of depending on what was open.
 * A name that resolves to nothing must be ignored rather than navigated to.
 *
 * No-ops in the browser, where the equivalent is an ordinary URL fragment.
 */
export function useDesktopDeepLink(onLink: (target: DesktopDeepLinkTarget) => void): void {
  // Held in a ref so the subscription survives for the app's lifetime instead of
  // being torn down and re-established every time the callback's identity changes.
  const handlerRef = useRef(onLink);
  handlerRef.current = onLink;

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;

    const apply = (target: DesktopDeepLinkTarget | null) => {
      if (isUsableTarget(target)) handlerRef.current(target);
    };

    // Deliberately not gated on `disposed`: the claim is one-shot, so a
    // StrictMode remount must not discard the only copy of the link.
    void claimPendingDeepLink().then(apply);

    onDesktopDeepLink((target) => {
      if (disposed) return;
      apply(target);
      // Rust parks every dispatched target so a link that launched the app
      // survives until the webview mounts. This one arrived with the webview
      // already listening, so drain the parked copy — otherwise the next reload
      // claims it and silently re-navigates to a link the user already followed.
      void takePendingDeepLink().catch(() => null);
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
