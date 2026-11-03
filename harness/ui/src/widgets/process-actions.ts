import type { ProcessInfo } from "../../../sdk/types";
import type { PageContextHandle } from "./types";

/** Stranded OS processes are listed so they can be killed; they have no transcript to open. */
export function canOpenProcess(process: Pick<ProcessInfo, "id">): boolean {
  return !process.id.startsWith("os:");
}

/**
 * Whether a kill would cut off work in progress rather than clean up a process
 * nobody is using. `interrupting` is left out on purpose: it has already been
 * told to stop, and a kill there is the escalation for a stop that got stuck.
 */
export function killNeedsConfirm(process: Pick<ProcessInfo, "status">): boolean {
  return process.status === "starting" || process.status === "running" || process.status === "paused";
}

/**
 * Open a session from wherever the widget is mounted. A scope owns its selection
 * and adopts the intent synchronously. A page without a scope has nothing
 * listening and no transcript of its own, so the session opens in the chat view.
 */
export function openProcessSession(
  id: string,
  pageContext: Pick<PageContextHandle, "emit" | "get" | "activateSession"> | undefined,
  onSelectSession: (id: string) => void,
): void {
  if (!pageContext) {
    onSelectSession(id);
    return;
  }
  pageContext.emit({ type: "select-session", sessionId: id });
  if (pageContext.get("sessionId") === id) return;
  (pageContext.activateSession ?? onSelectSession)(id);
}
