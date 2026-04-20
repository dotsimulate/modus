/**
 * View registry — single source of truth for all navigable views.
 *
 * Change a label or slug here and it updates everywhere:
 * nav links, hash router, URL building.
 */

export type StaticView = "home" | "chat";
export type View = StaticView | `page:${string}` | `move-page:${string}`;

/** Static nav links — chat-studio is the only hardcoded one. Additional views come from page discovery. */
export const NAV_VIEWS: { view: View; label: string }[] = [
  { view: "chat", label: "sessions" },
];

/** Set of all valid view slugs (for URL parsing). */
export const VIEW_SLUGS = new Set<string>(["home", "chat"]);

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
