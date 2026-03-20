/**
 * MoveWidget — dynamically loads and renders a move-local widget component.
 *
 * The widget source is served by the harness at /api/moves/:name/widget,
 * transpiled on-the-fly from the move's directory. The component receives
 * MoveWidgetProps including a `callOp` helper for calling move API ops
 * as the user (caller: "user").
 *
 * Module-level cache: loaded widget components are cached by URL so that
 * React unmount/remount cycles don't re-fetch and re-parse the module.
 * The cache persists for the lifetime of the page (survives React tree changes).
 */

import { useState, useEffect, useRef, useCallback, type ComponentType } from "react";
import * as ReactModule from "react";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";
import { callMoveOp, activateAttachedMoveApi, type MoveWidgetInfo } from "../api";
import { authHeaders } from "../api/_fetch";
import { onUiEvent } from "../sessionStore";

export type MoveWidgetEvent = {
  type: string;
  payload?: Record<string, unknown>;
};

export type ComposerAttachPayload = {
  label: string;
  data?: Record<string, unknown>;
};

export type ComposerAttachResult = {
  sent: boolean;
  userText: string;
};

export type MoveWidgetProps = {
  apiToken: string;
  instanceId: string;
  sessionId: string;
  moveName: string;
  callOp: (op: string, data?: Record<string, unknown>) => Promise<{
    ok: boolean;
    message?: string;
    error?: string;
  }>;
  submitMessage: (prompt: string) => Promise<void>;
  /**
   * Widget-first activation: triggers gather() + message send from the widget.
   * Only available for mountOnAttach moves. Runs gather() (which reads from
   * state the widget populated via callOp), then sends the resulting prompt
   * as a message to the session. Optional text is appended after gather output.
   */
  activate?: (text?: string) => Promise<{ ok: boolean; error?: string }>;
  subscribe?: (listener: (event: MoveWidgetEvent) => void) => () => void;
  /**
   * Attach content to the active chat composer instead of sending immediately.
   * Shows a chip in the composer; the user can add context and send when ready.
   * Resolves when the user sends the message (with their text), or rejects if detached.
   * Returns null if no composer is available.
   */
  attachToComposer?: (payload: ComposerAttachPayload) => Promise<ComposerAttachResult> | null;
};

export type Props = {
  widget: MoveWidgetInfo;
  apiToken: string;
  instanceId: string;
  sessionId: string;
  /** Whether this widget was mounted via mountOnAttach (enables activate prop) */
  mountedOnAttach?: boolean;
};

// ── Module-level widget cache ──
// Persists across React unmount/remount cycles. Keyed by module URL.
const moduleCache = new Map<string, ComponentType<MoveWidgetProps>>();

// ── Widget CSS cache ──
// Tracks which move CSS stylesheets have been injected into <head>.
const cssInjected = new Set<string>();

/** Inject a move's widget.css into <head> if it exists and hasn't been injected yet. */
async function loadWidgetCSS(cssUrl: string, moveName: string): Promise<void> {
  if (cssInjected.has(moveName)) return;
  try {
    const res = await fetch(cssUrl, { headers: authHeaders() });
    if (!res.ok) return; // no CSS file — that's fine
    const css = await res.text();
    if (!css.trim()) return;
    const style = document.createElement("style");
    style.setAttribute("data-move-widget", moveName);
    style.textContent = css;
    document.head.appendChild(style);
    cssInjected.add(moveName);
  } catch {
    // CSS loading is best-effort
  }
}

/** Evict a module from the cache (for reload). Returns true if it was cached. */
export function evictWidgetModule(url: string): boolean {
  return moduleCache.delete(url);
}

/**
 * Fetch widget JS, inject the host app's React into it via blob URL,
 * then dynamically import the blob. This avoids Vite intercepting the
 * import and appending ?import which breaks the harness route.
 */
async function loadWidgetModule(url: string, moveName: string): Promise<ComponentType<MoveWidgetProps>> {
  // Check module cache first (unless cache: "none" — handled by caller)
  const cached = moduleCache.get(url);
  if (cached) return cached;

  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Widget fetch failed: ${res.status}`);
  let js = await res.text();

  // Bun.build with external: ["react", "react-dom"] emits bare imports.
  // We register our React on a global and rewrite those imports to use it.
  (window as any).__MODUS_REACT__ = ReactModule;
  (window as any).__MODUS_JSX_RUNTIME__ = ReactJSXRuntime;
  (window as any).__MODUS_JSX_DEV_RUNTIME__ = ReactJSXDevRuntime;

  // Replace ESM imports of react/react-dom with global references
  js = js.replace(/from\s*["']react\/jsx-dev-runtime["']/g, 'from "__MODUS_JSX_DEV_RUNTIME__"');
  js = js.replace(/from\s*["']react\/jsx-runtime["']/g, 'from "__MODUS_JSX_RUNTIME__"');
  js = js.replace(/from\s*["']react["']/g, 'from "__MODUS_REACT__"');
  js = js.replace(/from\s*["']react-dom["']/g, 'from "__MODUS_REACT__"');

  // Wrap: export the component, import from globals via an importmap-like shim
  const shim = `
const __MODUS_REACT__ = window.__MODUS_REACT__;
const __MODUS_JSX_RUNTIME__ = window.__MODUS_JSX_RUNTIME__;
const __MODUS_JSX_DEV_RUNTIME__ = window.__MODUS_JSX_DEV_RUNTIME__;
${js.replace(/import\s*\{([^}]+)\}\s*from\s*["']__MODUS_REACT__["']/g, 'const {$1} = __MODUS_REACT__')
     .replace(/import\s*\*\s*as\s+(\w+)\s*from\s*["']__MODUS_REACT__["']/g, 'const $1 = __MODUS_REACT__')
     .replace(/import\s+(\w+)\s*from\s*["']__MODUS_REACT__["']/g, 'const $1 = __MODUS_REACT__')
     .replace(/import\s*\{([^}]+)\}\s*from\s*["']__MODUS_JSX_RUNTIME__["']/g, 'const {$1} = __MODUS_JSX_RUNTIME__')
     .replace(/import\s*\*\s*as\s+(\w+)\s*from\s*["']__MODUS_JSX_RUNTIME__["']/g, 'const $1 = __MODUS_JSX_RUNTIME__')
     .replace(/import\s*\{([^}]+)\}\s*from\s*["']__MODUS_JSX_DEV_RUNTIME__["']/g, 'const {$1} = __MODUS_JSX_DEV_RUNTIME__')
     .replace(/import\s*\*\s*as\s+(\w+)\s*from\s*["']__MODUS_JSX_DEV_RUNTIME__["']/g, 'const $1 = __MODUS_JSX_DEV_RUNTIME__')}
`;

  const blob = new Blob([shim], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    const mod = await import(/* @vite-ignore */ blobUrl);
    const Comp = mod.default ?? mod.Widget ?? mod[moveName];
    if (!Comp) throw new Error("Widget module has no default export");
    // Store in module cache
    moduleCache.set(url, Comp);
    return Comp;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function MoveWidget({ widget, apiToken, instanceId, sessionId, mountedOnAttach }: Props) {
  const [Component, setComponent] = useState<ComponentType<MoveWidgetProps> | null>(
    // Synchronous cache hit — no loading flash on remount
    () => moduleCache.get(widget.moduleUrl) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const loadedUrl = useRef<string | null>(widget.moduleUrl);

  useEffect(() => {
    if (loadedUrl.current === widget.moduleUrl && Component) return;
    loadedUrl.current = widget.moduleUrl;

    // For cache: "none", evict before loading
    if (widget.cache === "none") {
      evictWidgetModule(widget.moduleUrl);
    }

    // Synchronous cache check (module or instance cache mode)
    const cached = moduleCache.get(widget.moduleUrl);
    if (cached) {
      setComponent(() => cached);
      return;
    }

    setComponent(null);
    setError(null);

    // Derive CSS URL from module URL: /api/moves/:name/widget?cwd=... → /api/moves/:name/widget.css?cwd=...
    const cssUrl = widget.moduleUrl.replace("/widget?", "/widget.css?").replace(/\/widget$/, "/widget.css");
    loadWidgetCSS(cssUrl, widget.moveName);

    loadWidgetModule(widget.moduleUrl, widget.moveName)
      .then(Comp => setComponent(() => Comp))
      .catch(err => setError(`Failed to load widget: ${err}`));
  }, [widget.moduleUrl, widget.moveName, widget.cache]); // eslint-disable-line react-hooks/exhaustive-deps

  const callOp = useCallback(async (op: string, data?: Record<string, unknown>) => {
    return callMoveOp(widget.moveName, apiToken, op, data);
  }, [widget.moveName, apiToken]);

  const submitMessage = useCallback(async (prompt: string) => {
    await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt }),
    });
  }, [sessionId]);

  const activate = mountedOnAttach
    ? async (text?: string) => {
        const result = await activateAttachedMoveApi(widget.moveName, apiToken, text);
        return { ok: result.ok, error: result.error };
      }
    : undefined;

  const attachToComposer = useCallback((payload: ComposerAttachPayload): Promise<ComposerAttachResult> | null => {
    // Check if a composer is listening by dispatching a probe event
    let accepted = false;
    let resolve!: (result: ComposerAttachResult) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ComposerAttachResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const detail = {
      moveName: widget.moveName,
      apiToken,
      instanceId,
      label: payload.label,
      data: payload.data,
      resolve,
      reject,
      accept: () => { accepted = true; },
    };

    window.dispatchEvent(new CustomEvent("modus:widget-composer-attach", { detail }));
    return accepted ? promise : null;
  }, [widget.moveName, apiToken, instanceId]);

  const subscribe = useCallback((listener: (event: MoveWidgetEvent) => void) => (
    onUiEvent("move-widget-event", (eventSessionId, event) => {
      if (eventSessionId !== sessionId) return;
      if (event.instanceId !== instanceId) return;
      if (event.apiToken !== apiToken) return;
      if (!event.event || typeof event.event.type !== "string") return;
      listener(event.event as MoveWidgetEvent);
    })
  ), [apiToken, instanceId, sessionId]);

  if (error) {
    return <div className="panel-empty" style={{ color: "var(--color-error, #e55)" }}>{error}</div>;
  }

  if (!Component) {
    return <div className="panel-empty">Loading widget...</div>;
  }

  return (
    <Component
      apiToken={apiToken}
      instanceId={instanceId}
      sessionId={sessionId}
      moveName={widget.moveName}
      callOp={callOp}
      submitMessage={submitMessage}
      activate={activate}
      subscribe={subscribe}
      attachToComposer={attachToComposer}
    />
  );
}
