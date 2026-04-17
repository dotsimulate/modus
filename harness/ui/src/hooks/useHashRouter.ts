import { useState, useEffect, useCallback, useRef } from "react";
import { type View, VIEW_SLUGS, DEFAULT_VIEW } from "../views";
import { isSessionId } from "../sessionIds";

// Re-export for convenience
export type { View } from "../views";

/** Parse hash into { profile, view, sessionId }. Format: #[profile/]view[/sessionId] */
function parseHash(hash: string): { profile: string | null; view: View; sessionId: string | null } {
  const raw = hash.replace(/^#\/?/, "");
  const queryIndex = raw.indexOf("?");
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  if (!path) return { profile: null, view: DEFAULT_VIEW, sessionId: null };

  // Backwards compat: #dashboard → #profiles
  const compat = path === "dashboard" ? "profiles" : path;

  const slash = compat.indexOf("/");
  if (slash === -1) {
    if (VIEW_SLUGS.has(compat)) return { profile: null, view: compat as View, sessionId: null };
    if (compat.startsWith("page:")) return { profile: null, view: compat as View, sessionId: null };
    if (compat.startsWith("move-page:")) return { profile: null, view: compat as View, sessionId: null };
    // Bare session ID = chat session with no profile in URL
    if (isSessionId(compat)) return { profile: null, view: "chat", sessionId: compat };
    return { profile: compat, view: DEFAULT_VIEW, sessionId: null };
  }

  const prefix = compat.slice(0, slash);
  let suffix = compat.slice(slash + 1);
  if (suffix === "dashboard") suffix = "profiles";

  // #profile/sessionId (bare)
  if (isSessionId(suffix)) return { profile: prefix || null, view: "chat", sessionId: suffix };

  // #profile/page:X or #profile/page:X/sessionId — allow deep-linking into page views
  if (suffix.startsWith("page:") || suffix.startsWith("move-page:")) {
    const innerSlash = suffix.indexOf("/");
    if (innerSlash === -1) return { profile: prefix || null, view: suffix as View, sessionId: null };
    const viewPart = suffix.slice(0, innerSlash);
    const tail = suffix.slice(innerSlash + 1);
    return {
      profile: prefix || null,
      view: viewPart as View,
      sessionId: isSessionId(tail) ? tail : null,
    };
  }

  const view = VIEW_SLUGS.has(suffix) ? (suffix as View) : DEFAULT_VIEW;
  return { profile: prefix || null, view, sessionId: null };
}

function buildHash(profile: string | null, view: View, sessionId?: string | null): string {
  // "chat" view collapses to profile/sessionId for backwards-compat. Page views
  // keep their prefix and append sessionId as an extra segment.
  const isPageView = view.startsWith("page:") || view.startsWith("move-page:");
  let suffix: string;
  if (sessionId && view === "chat") {
    suffix = sessionId;
  } else if (sessionId && isPageView) {
    suffix = `${view}/${sessionId}`;
  } else if (view === DEFAULT_VIEW) {
    suffix = "";
  } else {
    suffix = view;
  }
  if (!profile && !suffix) return "";
  if (!profile) return suffix;
  if (!suffix) return profile;
  return `${profile}/${suffix}`;
}

const USER_PROFILE_KEY = "harness:active-user-profile";

export function useHashRouter() {
  const initial = parseHash(window.location.hash);
  // If URL has no profile segment, seed from localStorage so URL stays truthful
  const seedProfile = initial.profile ?? localStorage.getItem(USER_PROFILE_KEY) ?? null;
  const [view, setView] = useState<View>(initial.view);
  const [hashProfile, setHashProfile] = useState<string | null>(seedProfile);
  const [hashSessionId, setHashSessionId] = useState<string | null>(initial.sessionId);
  // Track whether the profile from the hash has been consumed by the app
  const consumedRef = useRef(false);

  // On mount, rewrite URL to include profile if it was missing
  useEffect(() => {
    if (initial.profile === null && seedProfile) {
      const hash = buildHash(seedProfile, initial.view, initial.sessionId);
      window.location.hash = hash;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => {
      const parsed = parseHash(window.location.hash);
      setView(parsed.view);
      setHashProfile(parsed.profile);
      setHashSessionId(parsed.sessionId);
      consumedRef.current = false;
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /** Navigate to a view, optionally setting the profile in the URL */
  const navigate = useCallback((target: View, profile?: string | null) => {
    const hash = buildHash(profile ?? hashProfile, target);
    window.location.hash = hash;
    setView(target);
    setHashSessionId(null);
    if (profile !== undefined) setHashProfile(profile);
  }, [hashProfile]);

  /** Update the URL to reflect the current profile without changing view */
  const setUrlProfile = useCallback((profile: string | null) => {
    setHashProfile(profile);
    const hash = buildHash(profile, view, hashSessionId);
    window.location.hash = hash;
  }, [view, hashSessionId]);

  /**
   * Update the URL to reflect a session. Preserves the current view when it's
   * a page view (page:X / move-page:X) or chat, so selecting a session inside
   * chat-studio-style pages keeps the user on that page. Other views flip to chat.
   */
  const setUrlSession = useCallback((sessionId: string | null, profile?: string | null) => {
    const p = profile !== undefined ? profile : hashProfile;
    setHashSessionId(sessionId);
    const isPageView = view.startsWith("page:") || view.startsWith("move-page:");
    const nextView: View = sessionId && !isPageView && view !== "chat" ? "chat" : view;
    if (nextView !== view) setView(nextView);
    if (sessionId) {
      const hash = buildHash(p, nextView, sessionId);
      window.history.replaceState(null, "", `#${hash}`);
    } else {
      const hash = buildHash(p, nextView);
      window.history.replaceState(null, "", hash ? `#${hash}` : window.location.pathname);
    }
  }, [hashProfile, view]);

  /** Consume the profile from the hash (marks it as handled) */
  const consumeHashProfile = useCallback(() => {
    if (consumedRef.current) return null;
    consumedRef.current = true;
    return hashProfile;
  }, [hashProfile]);

  return { view, navigate, hashProfile, hashSessionId, setUrlProfile, setUrlSession, consumeHashProfile };
}
