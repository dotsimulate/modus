import { modus } from "../modusClient";
import { compactModelName, sessionDisplayText, timeAgo } from "../utils/format";
import type { ContextMenuItem } from "./ContextMenu";

/** How many sessions the file-history submenu lists before deferring to the trace view. */
export const HISTORY_SESSION_LIMIT = 3;

const historyIcon = (
  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
    <path d="M6 2.5V6l2.5 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2"/>
  </svg>
);

/**
 * "Sessions that edited this" — shared by the editor, tab, markdown and file-tree menus.
 * Loads on submenu hover, not on menu open, so right-clicking never pays for a query the
 * user may not want. Returns null when the surface cannot navigate to a session.
 */
export function buildFileHistoryItem(
  path: string,
  onSelectSession?: (sessionId: string) => void,
): ContextMenuItem | null {
  if (!onSelectSession) return null;
  return {
    kind: "submenu",
    icon: historyIcon,
    label: "Sessions that edited this",
    loadingLabel: "reading history",
    emptyLabel: "no recorded edits",
    items: async () => {
      const sessions = await modus.fetchFileSessions(path, HISTORY_SESSION_LIMIT);
      return sessions.map((s): ContextMenuItem => {
        const changes = s.editCount + s.writeCount;
        const detail = [
          `${changes} change${changes === 1 ? "" : "s"}`,
          s.model ? compactModelName(s.model) : null,
          s.profile,
        ].filter(Boolean).join(" · ");
        return {
          kind: "action",
          label: sessionDisplayText({ title: s.title, last_prompt: s.lastPrompt, preview: s.preview })
            || s.sessionId.slice(0, 8),
          detail,
          meta: timeAgo(s.lastTouchedAt),
          status: s.status === "running" ? "running" : s.status === "error" ? "error" : "done",
          onClick: () => onSelectSession(s.sessionId),
        };
      });
    },
  };
}
