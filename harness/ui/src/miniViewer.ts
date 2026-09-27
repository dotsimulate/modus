/**
 * Mini viewer — a compact, phone-shaped window onto one session: tabs over the
 * conversation with the composer pinned underneath.
 *
 * It is the same app in a second window, selected by `?modusView=mini`. The
 * query survives desktop bootstrap (main.tsx rewrites the query but keeps keys
 * it does not own), so the flag is read once at module load.
 *
 * The content is an ordinary page layout. A project can replace it by authoring
 * a page with id `mini-viewer`; the editable tab panel keeps its own widget list
 * in localStorage under its node id, so tabs added with + persist per device.
 */

import type { LayoutNode, WidgetBase } from "./widgets";
import { invokeDesktop, isTauriRuntime } from "./desktopBridge";

export const MINI_VIEWER_PAGE_ID = "mini-viewer";

export const IS_MINI_VIEWER = typeof window !== "undefined"
  && new URLSearchParams(window.location.search).get("modusView") === "mini";

export const MINI_VIEWER_LAYOUT: LayoutNode = {
  kind: "scope",
  bindUrlSession: true,
  context: { sessionId: null },
  children: [{
    kind: "split",
    axis: "vertical",
    sizes: [1, "auto"],
    children: [
      {
        kind: "tabs",
        id: "mini-viewer-tabs",
        editable: true,
        target: true,
        activeTab: "mini-chat",
        handles: ["open-file", "open-terminal", "open-move", "close-move", "focus-tab"],
        children: [
          {
            kind: "widget",
            widget: { type: "session-chat", id: "mini-chat" },
            hideWhen: { sessionId: null },
          },
          {
            kind: "widget",
            widget: { type: "new-session", id: "mini-new" },
            publish: { selectedSession: "sessionId" },
            showWhen: { sessionId: null },
          },
          {
            kind: "widget",
            widget: { type: "code-editor", id: "mini-editor" },
          },
          {
            kind: "widget",
            widget: { type: "moves", id: "mini-moves" },
          },
          {
            kind: "widget",
            widget: { type: "session-history", id: "mini-history", focusTabOnSelect: "mini-chat" } as WidgetBase,
            publish: { selectedSession: "sessionId" },
            subscribe: { selectedSession: "sessionId" },
          },
        ],
      },
      {
        kind: "widget",
        widget: { type: "composer", id: "mini-composer", persistOpen: true } as WidgetBase,
        hideWhen: { sessionId: null },
      },
    ],
  }],
};

/** Same page and backend as this window, flagged mini, pointed at `hash`. */
export function miniViewerUrl(hash: string = window.location.hash): string {
  const params = new URLSearchParams(window.location.search);
  params.set("modusView", "mini");
  return `${window.location.pathname}?${params.toString()}${hash}`;
}

/**
 * Open (or re-point) the mini viewer at the session in `hash`.
 *
 * On desktop this is a native window the shell can keep above other apps. In a
 * browser it is a popup, which no page can pin on top — that needs the desktop.
 */
export async function openMiniViewer(hash: string = window.location.hash): Promise<void> {
  if (isTauriRuntime()) {
    const params = new URLSearchParams(window.location.search);
    params.set("modusView", "mini");
    await invokeDesktop<void>("desktop_open_mini_viewer", {
      request: { query: `?${params.toString()}`, hash },
    });
    return;
  }
  window.open(miniViewerUrl(hash), "modus-mini-viewer", "popup,width=440,height=760");
}

export async function setMiniViewerOnTop(onTop: boolean): Promise<boolean> {
  return invokeDesktop<boolean>("desktop_set_mini_viewer_on_top", { request: { onTop } });
}

export async function getMiniViewerOnTop(): Promise<boolean> {
  return invokeDesktop<boolean>("desktop_mini_viewer_on_top");
}

export async function showMainWindow(): Promise<void> {
  if (isTauriRuntime()) {
    await invokeDesktop<void>("desktop_show_main_window");
    return;
  }
  window.opener?.focus();
}

/** Must match `RETARGET_EVENT` in `desktop/src-tauri/src/mini_viewer.rs`. */
const RETARGET_EVENT = "modus:mini-viewer-retarget";

/**
 * Follow the shell when an already-open mini viewer is asked to show another
 * session. The hash router picks the change up like any other navigation.
 */
export async function onMiniViewerRetarget(): Promise<() => void> {
  // Provided by `withGlobalTauri`; absent in the browser build.
  const events = window.__TAURI__?.event;
  if (!events?.listen) return () => {};
  return events.listen<string>(RETARGET_EVENT, (event) => {
    if (typeof event.payload === "string" && event.payload.startsWith("#")) {
      window.location.hash = event.payload;
    }
  });
}
