/**
 * FloatingWindow — reusable portal-mounted, draggable, resizable floating panel.
 *
 * Extracted from ChatFileViewer shell mechanics. Handles:
 *   - Portal rendering to document.body
 *   - Bounds: position + size with localStorage persistence
 *   - Drag via header area
 *   - Resize via edge handles (8 directions)
 *   - Escape to close
 *   - Viewport clamping on window resize
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export type WindowBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  storageKey: string;
  defaultBounds?: Partial<WindowBounds>;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children: (dragProps: { onPointerDown: React.PointerEventHandler }) => ReactNode;
};

type InteractionState = {
  mode: "drag" | "resize";
  edge?: Edge;
  startX: number;
  startY: number;
  bounds: WindowBounds;
} | null;

const VIEWPORT_MARGIN = 12;
const RESIZE_EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof RESIZE_EDGES)[number];

function getDefaultBounds(
  minW: number,
  minH: number,
  overrides?: Partial<WindowBounds>,
): WindowBounds {
  const mw = Math.min(minW, window.innerWidth - VIEWPORT_MARGIN * 2);
  const mh = Math.min(minH, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = overrides?.width ?? Math.min(920, Math.max(mw, window.innerWidth - 80));
  const height = overrides?.height ?? Math.min(680, Math.max(mh, Math.round(window.innerHeight * 0.68)));
  const left = overrides?.left ?? Math.max(VIEWPORT_MARGIN, window.innerWidth - width - 28);
  const top = overrides?.top ?? Math.max(56, window.innerHeight - height - 88);
  return { top, left, width, height };
}

function clampBounds(bounds: WindowBounds, minW: number, minH: number): WindowBounds {
  const mw = Math.min(minW, window.innerWidth - VIEWPORT_MARGIN * 2);
  const mh = Math.min(minH, window.innerHeight - VIEWPORT_MARGIN * 2);
  const maxW = Math.max(mw, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxH = Math.max(mh, window.innerHeight - VIEWPORT_MARGIN * 2);
  const width = Math.min(Math.max(bounds.width, mw), maxW);
  const height = Math.min(Math.max(bounds.height, mh), maxH);
  const left = Math.min(
    Math.max(bounds.left, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  const top = Math.min(
    Math.max(bounds.top, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN),
  );
  return { top, left, width, height };
}

function clampResizeBounds(
  bounds: WindowBounds,
  initial: WindowBounds,
  edge: Edge,
  minW: number,
  minH: number,
): WindowBounds {
  const mw = Math.min(minW, window.innerWidth - VIEWPORT_MARGIN * 2);
  const mh = Math.min(minH, window.innerHeight - VIEWPORT_MARGIN * 2);
  const maxW = Math.max(mw, window.innerWidth - VIEWPORT_MARGIN * 2);
  const maxH = Math.max(mh, window.innerHeight - VIEWPORT_MARGIN * 2);
  const right = initial.left + initial.width;
  const bottom = initial.top + initial.height;
  const next = { ...bounds };

  if (edge.includes("w")) {
    next.width = Math.min(Math.max(next.width, mw), Math.min(maxW, right - VIEWPORT_MARGIN));
    next.left = right - next.width;
  } else if (edge.includes("e")) {
    next.width = Math.min(Math.max(next.width, mw), Math.min(maxW, window.innerWidth - initial.left - VIEWPORT_MARGIN));
    next.left = initial.left;
  }

  if (edge.includes("n")) {
    next.height = Math.min(Math.max(next.height, mh), Math.min(maxH, bottom - VIEWPORT_MARGIN));
    next.top = bottom - next.height;
  } else if (edge.includes("s")) {
    next.height = Math.min(Math.max(next.height, mh), Math.min(maxH, window.innerHeight - initial.top - VIEWPORT_MARGIN));
    next.top = initial.top;
  }

  return clampBounds(next, minW, minH);
}

function loadStoredBounds(
  key: string,
  minW: number,
  minH: number,
  overrides?: Partial<WindowBounds>,
): WindowBounds {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return getDefaultBounds(minW, minH, overrides);
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    if (
      typeof parsed.top !== "number" ||
      typeof parsed.left !== "number" ||
      typeof parsed.width !== "number" ||
      typeof parsed.height !== "number"
    ) {
      return getDefaultBounds(minW, minH, overrides);
    }
    return clampBounds(
      { top: parsed.top, left: parsed.left, width: parsed.width, height: parsed.height },
      minW,
      minH,
    );
  } catch {
    return getDefaultBounds(minW, minH, overrides);
  }
}

export function FloatingWindow({
  open,
  onClose,
  storageKey,
  defaultBounds,
  minWidth = 420,
  minHeight = 260,
  className,
  children,
}: Props) {
  const [bounds, setBounds] = useState<WindowBounds>(() =>
    loadStoredBounds(storageKey, minWidth, minHeight, defaultBounds),
  );
  const interactionRef = useRef<InteractionState>(null);

  // Reload stored bounds when window opens
  useEffect(() => {
    if (!open) return;
    setBounds(loadStoredBounds(storageKey, minWidth, minHeight, defaultBounds));
  }, [open]);

  // Persist bounds
  useEffect(() => {
    if (!open) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(bounds));
    } catch {}
  }, [bounds, open, storageKey]);

  // Escape to close + viewport resize clamping
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onResize = () => {
      setBounds((prev) => clampBounds(prev, minWidth, minHeight));
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open, onClose, minWidth, minHeight]);

  // Pointer move/up for drag and resize
  useEffect(() => {
    if (!open) return;

    const onPointerMove = (e: PointerEvent) => {
      const interaction = interactionRef.current;
      if (!interaction) return;

      const deltaX = e.clientX - interaction.startX;
      const deltaY = e.clientY - interaction.startY;

      if (interaction.mode === "drag") {
        setBounds(
          clampBounds(
            {
              ...interaction.bounds,
              left: interaction.bounds.left + deltaX,
              top: interaction.bounds.top + deltaY,
            },
            minWidth,
            minHeight,
          ),
        );
        return;
      }

      const next = { ...interaction.bounds };
      const edge = interaction.edge ?? "se";

      if (edge.includes("e")) next.width = interaction.bounds.width + deltaX;
      if (edge.includes("s")) next.height = interaction.bounds.height + deltaY;
      if (edge.includes("w")) {
        next.width = interaction.bounds.width - deltaX;
        next.left = interaction.bounds.left + deltaX;
      }
      if (edge.includes("n")) {
        next.height = interaction.bounds.height - deltaY;
        next.top = interaction.bounds.top + deltaY;
      }

      setBounds(clampResizeBounds(next, interaction.bounds, edge, minWidth, minHeight));
    };

    const onPointerUp = () => {
      interactionRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [open, minWidth, minHeight]);

  if (!open) return null;

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, textarea, a")) return;
    e.preventDefault();
    interactionRef.current = {
      mode: "drag",
      startX: e.clientX,
      startY: e.clientY,
      bounds,
    };
  };

  const startResize = (edge: Edge) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    interactionRef.current = {
      mode: "resize",
      edge,
      startX: e.clientX,
      startY: e.clientY,
      bounds,
    };
  };

  return createPortal(
    <div className="floating-window-overlay">
      <div className="floating-window-backdrop" />
      <div
        className={`floating-window${className ? ` ${className}` : ""}`}
        style={{
          top: bounds.top,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        }}
      >
        {children({ onPointerDown: startDrag })}
        {RESIZE_EDGES.map((edge) => (
          <div
            key={edge}
            className={`floating-window-resize floating-window-resize--${edge}`}
            onPointerDown={startResize(edge)}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

