/**
 * PageInspectProbe — measures the rendered page and posts the result back.
 *
 * Off unless explicitly enabled, and it renders nothing. When on, it waits for
 * layout to settle, walks the rendered tree with `captureBoxes`, and posts the
 * measured geometry plus its findings to `/api/page-inspect`, where whoever is
 * authoring the page can read it.
 *
 * The point is that a page author who is not sitting in front of the window can
 * still find out that a label is clipped at 118px or that a pane rendered three
 * pixels wide. Console logging would not do: packaged desktop builds have no
 * devtools at all, which is exactly the situation where a layout bug is hardest
 * to diagnose.
 *
 * Enable with any of:
 *   localStorage.setItem("modus:page-inspect", "1")   — persists across reloads
 *   window.__modusInspectPage()                       — one-shot, from a console
 *   window.dispatchEvent(new Event("modus:inspect-page"))
 */

import { useEffect, useRef } from "react";
import { API_BASE, authHeaders } from "../modusClient";
import { inspectPage } from "../page-inspect";

const ENABLE_KEY = "modus:page-inspect";
const INSPECT_EVENT = "modus:inspect-page";

/**
 * How long to wait before measuring. Two animation frames get us past React's
 * commit and the browser's first layout pass; the timeout covers widgets that
 * fetch and then resize, which is most of them.
 */
const SETTLE_MS = 500;

function inspectEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLE_KEY) === "1";
  } catch {
    return false;
  }
}

declare global {
  interface Window {
    __modusInspectPage?: () => void;
  }
}

export function PageInspectProbe({
  containerRef,
  pageId,
  layoutName,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>;
  pageId: string;
  layoutName?: string;
}) {
  // Read through a ref so the measuring effect does not re-subscribe whenever
  // the page re-renders, which on a live session is constantly.
  const metaRef = useRef({ pageId, layoutName });
  metaRef.current = { pageId, layoutName };

  useEffect(() => {
    let cancelled = false;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let frame = 0;

    const measure = () => {
      const root = containerRef.current;
      if (!root || cancelled) return;
      let report;
      try {
        report = inspectPage(root, metaRef.current);
      } catch {
        // A measurement failure must never take the page down with it.
        return;
      }
      void fetch(`${API_BASE}/api/page-inspect`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify(report),
      }).catch(() => {});
    };

    const scheduleMeasure = () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(measure);
        });
      }, SETTLE_MS);
    };

    if (inspectEnabled()) scheduleMeasure();

    // Manual triggers work whether or not the persistent flag is set, so a
    // one-off measurement does not require changing stored state.
    const onEvent = () => scheduleMeasure();
    window.addEventListener(INSPECT_EVENT, onEvent);
    window.__modusInspectPage = onEvent;

    const onResize = () => {
      if (inspectEnabled()) scheduleMeasure();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      if (settleTimer) clearTimeout(settleTimer);
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener(INSPECT_EVENT, onEvent);
      window.removeEventListener("resize", onResize);
      if (window.__modusInspectPage === onEvent) delete window.__modusInspectPage;
    };
  }, [containerRef]);

  return null;
}
