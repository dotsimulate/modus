/**
 * Building a shareable link to a session.
 *
 * Two forms, because a link is only useful on the client that opens it. The
 * desktop shell registers the `modus://` scheme with the OS; a browser tab does
 * not, so a `modus://` URL pasted into a phone opens nothing. The browser form
 * is an ordinary fragment on the origin the user is already talking to — which
 * under the desktop shell is a moving OS-assigned port, and is precisely why
 * the scheme exists.
 *
 * The project is carried in the fragment even though a session id is globally
 * unique, because the hash route resolves it differently than a deep link does:
 * `useDesktopDeepLink` waits for the session index and derives the owning
 * project, while `useHashRouter` seeds the profile from local storage when a
 * route omits it. A bare `#<id>` would therefore open under whatever project
 * the *recipient* had last used. The `modus://` form needs no project for the
 * same reason it is not allowed one — it derives it.
 */

export type SessionLinkInput = {
  sessionId: string;
  /** Owning project (user profile name). Omitted for the desktop form. */
  project?: string | null;
  /** True inside the Tauri shell, where `modus://` is registered. */
  desktop: boolean;
  /** Browser base, normally `location.origin + location.pathname`. */
  base?: string;
};

export function buildSessionLink({ sessionId, project, desktop, base }: SessionLinkInput): string {
  if (desktop) return `modus://session/${sessionId}`;
  // Mirrors buildHash() in useHashRouter: the chat view collapses to
  // `<profile>/<sessionId>`, and the profile segment is dropped when absent.
  const fragment = project ? `${project}/${sessionId}` : sessionId;
  return `${stripFragment(base ?? "")}#${fragment}`;
}

function stripFragment(base: string): string {
  const hash = base.indexOf("#");
  return hash === -1 ? base : base.slice(0, hash);
}
