import { useEffect, useState } from "react";
import type { LayoutNode } from "../widgets";
import type { View } from "../views";
import { isTauriRuntime } from "../desktopBridge";
import { getMiniViewerOnTop, onMiniViewerRetarget, setMiniViewerOnTop, showMainWindow } from "../miniViewer";
import { PageView } from "./PageRenderer";

type Props = {
  layout: LayoutNode;
  layouts?: { mobile?: LayoutNode };
  context?: Record<string, unknown>;
  pageId: string;
  title: string;
  hashSessionId: string | null;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  onActivateSession: (id: string, project?: string | null) => void;
};

/**
 * Chrome for the mini viewer window: one slim bar, then the page. The main
 * app's nav, side panels, agent portal, and floating windows are deliberately
 * absent — this window is for keeping one conversation in reach.
 */
export function MiniViewerShell({
  layout, layouts, context, pageId, title, hashSessionId,
  onNavigate, onSelectSession, onActivateSession,
}: Props) {
  const desktop = isTauriRuntime();
  const [onTop, setOnTop] = useState<boolean | null>(null);

  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    getMiniViewerOnTop()
      .then((value) => { if (!cancelled) setOnTop(value); })
      .catch(() => {});
    // The tray can flip the pin while this window is open; re-read on focus.
    const refresh = () => {
      getMiniViewerOnTop().then(setOnTop).catch(() => {});
    };
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [desktop]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    onMiniViewerRetarget()
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  useEffect(() => {
    document.title = title ? `${title} · Modus mini` : "Modus mini";
  }, [title]);

  const togglePin = () => {
    if (onTop === null) return;
    setMiniViewerOnTop(!onTop).then(setOnTop).catch(() => {});
  };

  return (
    <div className="app app--mini">
      <div className="mini-bar">
        <span className="mini-bar-title" title={title}>{title || "Modus"}</span>
        {desktop && onTop !== null && (
          <button
            className={`mini-bar-btn${onTop ? " mini-bar-btn--active" : ""}`}
            onClick={togglePin}
            title={onTop ? "Stop keeping this window on top" : "Keep this window on top of other apps"}
            aria-pressed={onTop}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 1.5h3l-.5 3 2 1.5v1H3v-1l2-1.5-.5-3Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" fill={onTop ? "currentColor" : "none"} />
              <path d="M6 7v3.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>
        )}
        <button
          className="mini-bar-btn"
          onClick={() => { void showMainWindow().catch(() => {}); }}
          title="Show the full Modus window"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <rect x="1.5" y="1.5" width="9" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
            <path d="M1.5 4h9" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>
      </div>
      <div className="app-body">
        <PageView
          layout={layout}
          layouts={layouts}
          context={context}
          padding={0}
          onNavigate={onNavigate}
          onSelectSession={onSelectSession}
          onActivateSession={onActivateSession}
          hashSessionId={hashSessionId}
          pageId={pageId}
        />
      </div>
    </div>
  );
}
