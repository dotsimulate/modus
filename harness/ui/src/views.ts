/**
 * View registry — single source of truth for all navigable views.
 *
 * Change a label or slug here and it updates everywhere:
 * nav links, hash router, URL building.
 */

export type View = "home" | "chat" | "profiles" | "memory" | "actions" | "git";

/** Views shown as nav links, in display order. "home" is the logo, not a nav link. */
export const NAV_VIEWS: { view: View; label: string }[] = [
  { view: "chat",     label: "sessions" },
  { view: "profiles", label: "profiles" },
  { view: "actions",  label: "actions" },
  { view: "memory",   label: "memory" },
  { view: "git",      label: "git" },
];

/** Set of all valid view slugs (for URL parsing). */
export const VIEW_SLUGS = new Set<string>(["home", ...NAV_VIEWS.map((v) => v.view)]);

/** The default view when no hash is present. */
export const DEFAULT_VIEW: View = "home";
