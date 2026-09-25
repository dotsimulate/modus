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
import { modus, authHeaders } from "../modusClient";
import { backendUrl } from "../backendTarget";
import type { MoveWidgetInfo } from "../../../sdk/index";
import type { PageContextHandle } from "../widgets/types";
import { onUiEvent } from "../sessionStore";
import {
  evictMoveComponent,
  getCachedMoveComponent,
  loadMoveComponent,
  loadMoveComponentCSS,
} from "./move-component-loader";

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
   * Throws on failure — wrap in try/catch to handle errors.
   */
  activate?: (text?: string) => Promise<void>;
  subscribe?: (listener: (event: MoveWidgetEvent) => void) => () => void;
  /**
   * Attach content to the active chat composer instead of sending immediately.
   * Shows a chip in the composer; the user can add context and send when ready.
   * Resolves when the user sends the message (with their text), or rejects if detached.
   * Returns null if no composer is available.
   */
  attachToComposer?: (payload: ComposerAttachPayload) => Promise<ComposerAttachResult> | null;
  pageContext?: PageContextHandle;
};

export type Props = {
  widget: MoveWidgetInfo;
  apiToken: string;
  instanceId: string;
  sessionId: string;
  /** Whether this widget was mounted via mountOnAttach (enables activate prop) */
  mountedOnAttach?: boolean;
  pageContext?: PageContextHandle;
};

/** Evict a module from the cache (for reload). Returns true if it was cached. */
export function evictWidgetModule(url: string): boolean {
  return evictMoveComponent(backendUrl(url));
}

/** Refresh server handlers as well as widget code for an attached move. */
export async function reloadMoveWidgetRegistration(
  widget: MoveWidgetInfo, apiToken: string, instanceId: string, sessionId: string, mountedOnAttach?: boolean,
): Promise<void> {
  if (!mountedOnAttach) return;
  const cwd = new URL(widget.moduleUrl, window.location.href).searchParams.get("cwd");
  if (!cwd) throw new Error("Move widget URL has no project directory");
  const attached = await modus.attachMove({
    moveName: widget.moveName, inputs: { instanceId }, cwd, sessionId,
  });
  if (attached.apiToken !== apiToken) throw new Error("Move widget registration changed its API token");
}

export function MoveWidget({ widget, apiToken, instanceId, sessionId, mountedOnAttach, pageContext }: Props) {
  const moduleUrl = backendUrl(widget.moduleUrl);
  const [Component, setComponent] = useState<ComponentType<MoveWidgetProps> | null>(
    // Synchronous cache hit — no loading flash on remount
    () => getCachedMoveComponent<MoveWidgetProps>(moduleUrl),
  );
  const [error, setError] = useState<string | null>(null);
  const loadedUrl = useRef<string | null>(moduleUrl);

  useEffect(() => {
    if (loadedUrl.current === moduleUrl && Component) return;
    loadedUrl.current = moduleUrl;

    // For cache: "none", evict before loading
    if (widget.cache === "none") {
      evictWidgetModule(moduleUrl);
    }

    // Synchronous cache check (module or instance cache mode)
    const cached = getCachedMoveComponent<MoveWidgetProps>(moduleUrl);
    if (cached) {
      setComponent(() => cached);
      return;
    }

    setComponent(null);
    setError(null);

    // Derive CSS URL from module URL: /api/moves/:name/widget?cwd=... → /api/moves/:name/widget.css?cwd=...
    const cssUrl = moduleUrl.replace("/widget?", "/widget.css?").replace(/\/widget$/, "/widget.css");
    loadMoveComponentCSS(cssUrl, widget.moveName);

    loadMoveComponent<MoveWidgetProps>(moduleUrl, widget.moveName)
      .then(Comp => setComponent(() => Comp))
      .catch(err => setError(`Failed to load widget: ${err}`));
  }, [moduleUrl, widget.moveName, widget.cache]); // eslint-disable-line react-hooks/exhaustive-deps

  const callOp = useCallback(async (op: string, data?: Record<string, unknown>) => {
    return modus.callMoveOp(widget.moveName, apiToken, op, data);
  }, [widget.moveName, apiToken]);

  const submitMessage = useCallback(async (prompt: string) => {
    await fetch(backendUrl(`/api/sessions/${sessionId}/messages`), {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt }),
    });
  }, [sessionId]);

  const activate = mountedOnAttach
    ? async (text?: string) => {
        const result = await modus.activateAttached(widget.moveName, apiToken, text);
        if (!result.ok) {
          throw new Error(result.error ?? "activate() failed");
        }
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
      pageContext={pageContext}
    />
  );
}
