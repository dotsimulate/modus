export type MissingPageNavigation = "none" | "wait" | "chat" | "home";

/**
 * Decide only after the page list is known to describe the current cwd. A
 * session-bearing page failure recovers to chat; dashboard is reserved for a
 * genuinely sessionless route.
 */
export function resolveMissingPageNavigation(input: {
  customPageId: string | null;
  activeCustomPage: boolean;
  projectCwd?: string | null;
  pagesDiscoveredFor: string | null;
  sessionId?: string | null;
}): MissingPageNavigation {
  if (!input.customPageId || input.activeCustomPage) return "none";
  if (input.projectCwd && input.pagesDiscoveredFor !== input.projectCwd) return "wait";
  return input.sessionId ? "chat" : "home";
}
