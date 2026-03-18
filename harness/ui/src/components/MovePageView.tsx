/**
 * MovePageView — renders a move's widget as a full page.
 *
 * Auto-attaches the move on mount (creating an API registration),
 * then loads the widget component with callOp support.
 * No session required — this is a standalone page view.
 *
 * Uses a module-level cache of attach results keyed by (moveName, cwd)
 * so that React unmount/remount cycles don't re-fire the attach API
 * and don't flash "Loading..." while the module cache already has the component.
 */

import { useState, useEffect, useRef } from "react";
import { attachMoveApi, callMoveOp } from "../api";
import { MoveWidget, evictWidgetModule } from "./MoveWidget";
import type { MoveWidgetInfo } from "../api";

type Props = {
  moveName: string;
  cwd: string;
  userProfile?: string;
};

type AttachState = {
  apiToken: string;
  instanceId: string;
  widget: MoveWidgetInfo;
};

// Module-level cache of attach results — survives React unmount/remount.
// Keyed by "moveName\0cwd" to avoid re-attaching on every render cycle.
const attachCache = new Map<string, AttachState>();

function attachKey(moveName: string, cwd: string): string {
  return `${moveName}\0${cwd}`;
}

export function MovePageView({ moveName, cwd, userProfile }: Props) {
  const key = attachKey(moveName, cwd);
  const [attachment, setAttachment] = useState<AttachState | null>(
    () => attachCache.get(key) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const attachingRef = useRef(false);

  useEffect(() => {
    // Already have a cached result for this move+cwd
    const cached = attachCache.get(key);
    if (cached) {
      setAttachment(cached);
      return;
    }

    if (attachingRef.current) return;
    attachingRef.current = true;

    attachMoveApi({
      moveName,
      inputs: {},
      cwd,
      userProfile,
    })
      .then((result) => {
        attachCache.set(key, result);
        setAttachment(result);
      })
      .catch((err) => setError(String(err)))
      .finally(() => { attachingRef.current = false; });
  }, [moveName, cwd, userProfile, key]);

  const handleReload = () => {
    if (attachment) {
      evictWidgetModule(attachment.widget.moduleUrl);
    }
    attachCache.delete(key);
    setAttachment(null);
    setError(null);
    attachingRef.current = false;
    setReloadKey(k => k + 1);

    // Re-attach
    attachMoveApi({ moveName, inputs: {}, cwd, userProfile })
      .then((result) => {
        attachCache.set(key, result);
        setAttachment(result);
      })
      .catch((err) => setError(String(err)));
  };

  if (error) {
    return (
      <div className="view-container" style={{ padding: "24px", color: "var(--color-error, #e55)" }}>
        Failed to load move page "{moveName}": {error}
        <button
          onClick={handleReload}
          style={{ marginLeft: 12, padding: "4px 10px", cursor: "pointer" }}
        >
          retry
        </button>
      </div>
    );
  }

  if (!attachment) {
    return (
      <div className="view-container" style={{ padding: "24px", color: "var(--text-muted, #888)" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="view-container" style={{ height: "100%", overflow: "auto", position: "relative" }}>
      <button
        onClick={handleReload}
        title="Reload widget"
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 10,
          background: "var(--bg-secondary, #2a2a2a)",
          border: "1px solid var(--border-color, #444)",
          borderRadius: 4,
          padding: "3px 6px",
          cursor: "pointer",
          color: "var(--text-muted, #888)",
          display: "flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
        }}
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <path d="M10 2v3H7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M9.5 7.5a4 4 0 1 1-.9-4.1L10 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
      </button>
      <MoveWidget
        key={reloadKey}
        widget={attachment.widget}
        apiToken={attachment.apiToken}
        instanceId={attachment.instanceId}
        sessionId=""
        mountedOnAttach
      />
    </div>
  );
}
