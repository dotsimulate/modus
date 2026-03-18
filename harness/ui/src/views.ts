/**
 * View registry — single source of truth for all navigable views.
 *
 * Change a label or slug here and it updates everywhere:
 * nav links, hash router, URL building.
 */

export type StaticView = "home" | "chat" | "profiles" | "actions" | "git" | "web" | "trace";
export type View = StaticView | `page:${string}` | `move-page:${string}`;

/** Views shown as nav links, in display order. "home" is the logo, not a nav link. */
export const NAV_VIEWS: { view: StaticView; label: string }[] = [
  { view: "chat",     label: "sessions" },
  { view: "profiles", label: "profiles" },
  { view: "actions",  label: "actions" },
  { view: "git",      label: "git" },
  { view: "web",      label: "web" },
  { view: "trace",    label: "trace" },
];

/** Set of all valid view slugs (for URL parsing). */
export const VIEW_SLUGS = new Set<string>(["home", ...NAV_VIEWS.map((v) => v.view)]);

/** The default view when no hash is present. */
export const DEFAULT_VIEW: StaticView = "home";

export function customPageView(pageId: string): View {
  return `page:${pageId}`;
}

export function getCustomPageId(view: View): string | null {
  return view.startsWith("page:") ? view.slice("page:".length) : null;
}

export function movePageView(moveName: string): View {
  return `move-page:${moveName}`;
}

export function getMovePageName(view: View): string | null {
  return view.startsWith("move-page:") ? view.slice("move-page:".length) : null;
}
