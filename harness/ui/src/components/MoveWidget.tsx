/**
 * MoveWidget — dynamically loads and renders a move-local widget component.
 *
 * The widget source is served by the harness at /api/moves/:name/widget,
 * transpiled on-the-fly from the move's directory. The component receives
 * MoveWidgetProps including a `callOp` helper for calling move API ops
 * as the user (caller: "user").
 */

import React, { useState, useEffect, useRef, type ComponentType } from "react";
import * as ReactModule from "react";
import * as ReactJSXRuntime from "react/jsx-runtime";
import * as ReactJSXDevRuntime from "react/jsx-dev-runtime";
import { callMoveOp, type MoveWidgetInfo } from "../api";
import { authHeaders } from "../api/_fetch";

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
};

type Props = {
  widget: MoveWidgetInfo;
  apiToken: string;
  instanceId: string;
  sessionId: string;
};

/**
 * Fetch widget JS, inject the host app's React into it via blob URL,
 * then dynamically import the blob. This avoids Vite intercepting the
 * import and appending ?import which breaks the harness route.
 */
async function loadWidgetModule(url: string, moveName: string): Promise<ComponentType<MoveWidgetProps>> {
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
    return Comp;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export function MoveWidget({ widget, apiToken, instanceId, sessionId }: Props) {
  const [Component, setComponent] = useState<ComponentType<MoveWidgetProps> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedUrl = useRef<string | null>(null);

  useEffect(() => {
    if (loadedUrl.current === widget.moduleUrl) return;
    loadedUrl.current = widget.moduleUrl;
    setComponent(null);
    setError(null);

    loadWidgetModule(widget.moduleUrl, widget.moveName)
      .then(Comp => setComponent(() => Comp))
      .catch(err => setError(`Failed to load widget: ${err}`));
  }, [widget.moduleUrl, widget.moveName]);

  const callOp = async (op: string, data?: Record<string, unknown>) => {
    return callMoveOp(widget.moveName, apiToken, op, data);
  };

  const submitMessage = async (prompt: string) => {
    await fetch(`/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ prompt }),
    });
  };

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
    />
  );
}
