/**
 * MoveWidgetEmbed — renders a move widget inside a page or panel layout.
 *
 * When a page layout references { "type": "move:chess" }, PanelTreeRenderer
 * delegates to this component. It auto-attaches the move (creating an API
 * registration), loads the widget component via MoveWidget, and integrates
 * with the page context bus.
 *
 * Attachment results are cached at module scope by (moveName, cwd, widgetId)
 * so that React unmount/remount cycles don't re-fire the attach API.
 */

import { useState, useEffect, useRef } from "react";
import { modus } from "../modusClient";
import { MoveWidget } from "./MoveWidget";
import { useProfiles } from "../providers/ProfileContext";
import type { AttachMoveResult } from "../../../sdk/index";
import type { PageContextHandle } from "../widgets/types";

type Props = {
  moveName: string;
  widgetId: string;
  pageContext?: PageContextHandle;
};

// Module-level cache — survives React unmount/remount.
// Keyed by "moveName\0cwd\0widgetId".
const embedCache = new Map<string, AttachMoveResult>();

function cacheKey(moveName: string, cwd: string, widgetId: string): string {
  return `${moveName}\0${cwd}\0${widgetId}`;
}

export function MoveWidgetEmbed({ moveName, widgetId, pageContext }: Props) {
  const { activeCwd, activeUserProfile } = useProfiles();
  const cwd = activeCwd ?? "";
  const key = cacheKey(moveName, cwd, widgetId);

  const [attachment, setAttachment] = useState<AttachMoveResult | null>(
    () => embedCache.get(key) ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const attachingRef = useRef(false);

  useEffect(() => {
    if (!cwd) return;

    const cached = embedCache.get(key);
    if (cached) {
      setAttachment(cached);
      return;
    }

    if (attachingRef.current) return;
    attachingRef.current = true;

    modus.attachMove({
      moveName,
      inputs: {},
      cwd,
      userProfile: activeUserProfile ?? undefined,
    })
      .then((result) => {
        embedCache.set(key, result);
        setAttachment(result);
      })
      .catch((err) => setError(String(err)))
      .finally(() => { attachingRef.current = false; });
  }, [moveName, cwd, activeUserProfile, key]);

  if (error) {
    return (
      <div className="panel-empty" style={{ color: "var(--color-error, #e55)" }}>
        move:{moveName} — {error}
      </div>
    );
  }

  if (!attachment) {
    return <div className="panel-empty">loading move:{moveName}...</div>;
  }

  return (
    <MoveWidget
      widget={attachment.widget}
      apiToken={attachment.apiToken}
      instanceId={attachment.instanceId}
      sessionId=""
      mountedOnAttach
      pageContext={pageContext}
    />
  );
}
