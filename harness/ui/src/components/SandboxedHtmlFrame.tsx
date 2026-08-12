/**
 * SandboxedHtmlFrame — the one way Modus renders agent-authored HTML.
 *
 * Four call sites grew their own `srcDoc` iframe independently (preview panel,
 * file preview, git file view, move tool views). They shared the sandbox
 * *constant* but not the element, and they had already drifted apart on policy.
 * This component owns the frame so the policy lives in one place.
 *
 * Sizing is the reason it needs to be a component rather than a constant. The
 * frame is deliberately opaque-origin — `allow-scripts` WITHOUT
 * `allow-same-origin`, see htmlSandbox.ts — so the embedder cannot read the
 * document and neither CSS nor script can measure it from outside. A frame that
 * grows to its content is only possible if the guest reports its own height, so
 * `fit="content"` appends a small reporter to the document and listens for it.
 *
 * That reporting is best-effort by design. A document whose scripts do not run
 * — the embedder's CSP is inherited by srcdoc, so this is a real case, not a
 * hypothetical — simply keeps `fallbackHeight`. Nothing waits on the message
 * and nothing renders an error if it never arrives, because a silent wrong
 * answer here is worse than a slightly-too-short frame.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { HTML_PREVIEW_SANDBOX } from "../htmlSandbox";

/** Namespaced so an ordinary postMessage from a document cannot resize its own frame by accident. */
const HEIGHT_CHANNEL = "modus-html-frame-height";

/**
 * A reported height is untrusted input from the document being displayed.
 * Clamping is what keeps a hostile or broken page from asking for a layout
 * tall enough to wedge the transcript.
 */
const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_MAX_HEIGHT = 6000;

export type SandboxedHtmlFrameProps = {
  html: string;
  title: string;
  className?: string;
  /**
   * "fill" leaves sizing to CSS — correct for a panel that owns its box.
   * "content" grows the frame to the document, for HTML embedded in a
   * transcript where there is no outer box to fill.
   */
  fit?: "fill" | "content";
  /** Used until the document reports, and forever if it never does. */
  fallbackHeight?: number;
  minHeight?: number;
  maxHeight?: number;
};

const REPORTER = `<script>(function(){
  if (window.__modusHeightReporter) return;
  window.__modusHeightReporter = 1;
  var last = -1;
  function report(){
    var d = document.documentElement, b = document.body;
    var h = Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, b ? b.offsetHeight : 0);
    if (!h || h === last) return;
    last = h;
    try { parent.postMessage({ channel: ${JSON.stringify(HEIGHT_CHANNEL)}, height: h }, "*"); } catch (e) {}
  }
  if (document.readyState === "complete") report(); else window.addEventListener("load", report);
  document.addEventListener("DOMContentLoaded", report);
  if (window.ResizeObserver && document.documentElement) {
    try { new ResizeObserver(report).observe(document.documentElement); } catch (e) {}
  }
  setTimeout(report, 0);
  setTimeout(report, 300);
})();</script>`;

/**
 * Append rather than splice into <head>. The input is agent-authored and may be
 * a fragment, may omit <body>, or may be malformed; trailing content is folded
 * into the body by the parser in every one of those cases, whereas a regex
 * looking for a closing tag silently does nothing when the tag is absent.
 */
function withReporter(html: string): string {
  return `${html}\n${REPORTER}`;
}

export function SandboxedHtmlFrame({
  html,
  title,
  className,
  fit = "fill",
  fallbackHeight = 420,
  minHeight = DEFAULT_MIN_HEIGHT,
  maxHeight = DEFAULT_MAX_HEIGHT,
}: SandboxedHtmlFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState(fallbackHeight);
  const sizesToContent = fit === "content";

  const srcDoc = useMemo(
    () => (sizesToContent ? withReporter(html) : html),
    [html, sizesToContent],
  );

  // New document, new height. Without this a short page keeps a tall frame.
  useEffect(() => {
    if (sizesToContent) setHeight(fallbackHeight);
  }, [srcDoc, sizesToContent, fallbackHeight]);

  useEffect(() => {
    if (!sizesToContent) return;
    const onMessage = (event: MessageEvent) => {
      // The frame is opaque-origin, so event.origin is the string "null" and is
      // useless as a filter. Identity of the sending window is the real check,
      // and it also stops one frame resizing another.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { channel?: unknown; height?: unknown } | null;
      if (!data || typeof data !== "object" || data.channel !== HEIGHT_CHANNEL) return;
      const reported = Number(data.height);
      if (!Number.isFinite(reported) || reported <= 0) return;
      setHeight(Math.min(Math.max(Math.ceil(reported), minHeight), maxHeight));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sizesToContent, minHeight, maxHeight]);

  return (
    <iframe
      ref={frameRef}
      className={className}
      srcDoc={srcDoc}
      sandbox={HTML_PREVIEW_SANDBOX}
      title={title}
      style={sizesToContent ? { height, width: "100%", border: 0, display: "block" } : undefined}
    />
  );
}

export const __testing = { HEIGHT_CHANNEL, withReporter, DEFAULT_MIN_HEIGHT, DEFAULT_MAX_HEIGHT };
