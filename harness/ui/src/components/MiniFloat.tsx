/**
 * MiniFloat — lightweight portal-mounted floating widget.
 *
 * Designed for small persistent HUD elements (not modal panels).
 * Differences from FloatingWindow:
 *   - No overlay wrapper, no backdrop — truly ambient
 *   - Drag by any non-interactive surface (no dedicated header needed)
 *   - Single SE corner resize handle
 *   - No escape-to-close (it's a HUD, not a modal)
 *   - container-type: size built into the root el — children use @container
 *   - Much smaller defaults and minimums
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MiniFloatBounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type Props = {
  open: boolean;
  storageKey: string;
  defaultBounds?: Partial<MiniFloatBounds>;
  minWidth?: number;
  minHeight?: number;
  className?: string;
  children: ReactNode;
};

// react import
import type { ReactNode } from "react";

const MARGIN = 8;

function clamp(bounds: MiniFloatBounds, minW: number, minH: number): MiniFloatBounds {
  const maxW = window.innerWidth - MARGIN * 2;
  const maxH = window.innerHeight - MARGIN * 2;
  const width  = Math.min(Math.max(bounds.width,  minW), maxW);
  const height = Math.min(Math.max(bounds.height, minH), maxH);
  const left = Math.min(Math.max(bounds.left, MARGIN), window.innerWidth  - width  - MARGIN);
  const top  = Math.min(Math.max(bounds.top,  MARGIN), window.innerHeight - height - MARGIN);
  return { top, left, width, height };
}

function defaults(minW: number, minH: number, overrides?: Partial<MiniFloatBounds>): MiniFloatBounds {
  const width  = overrides?.width  ?? minW;
  const height = overrides?.height ?? minH;
  const left   = overrides?.left   ?? Math.max(MARGIN, window.innerWidth  - width  - 16);
  const top    = overrides?.top    ?? Math.max(48,     window.innerHeight - height - 80);
  return clamp({ top, left, width, height }, minW, minH);
}

function load(key: string, minW: number, minH: number, overrides?: Partial<MiniFloatBounds>): MiniFloatBounds {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaults(minW, minH, overrides);
    const p = JSON.parse(raw) as Partial<MiniFloatBounds>;
    if (typeof p.top !== "number" || typeof p.left !== "number" ||
        typeof p.width !== "number" || typeof p.height !== "number") {
      return defaults(minW, minH, overrides);
    }
    return clamp({ top: p.top, left: p.left, width: p.width, height: p.height }, minW, minH);
  } catch {
    return defaults(minW, minH, overrides);
  }
}

type Drag = { startX: number; startY: number; bounds: MiniFloatBounds } | null;
type Resize = { startX: number; startY: number; bounds: MiniFloatBounds } | null;

export function MiniFloat({
  open,
  storageKey,
  defaultBounds,
  minWidth  = 160,
  minHeight = 80,
  className,
  children,
}: Props) {
  const [bounds, setBounds] = useState<MiniFloatBounds>(() =>
    load(storageKey, minWidth, minHeight, defaultBounds),
  );
  const dragRef   = useRef<Drag>(null);
  const resizeRef = useRef<Resize>(null);

  // Restore bounds on open
  useEffect(() => {
    if (open) setBounds(load(storageKey, minWidth, minHeight, defaultBounds));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist bounds
  useEffect(() => {
    if (!open) return;
    try { localStorage.setItem(storageKey, JSON.stringify(bounds)); } catch {}
  }, [bounds, open, storageKey]);

  // Clamp on viewport resize
  useEffect(() => {
    if (!open) return;
    const handler = () => setBounds((b) => clamp(b, minWidth, minHeight));
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [open, minWidth, minHeight]);

  // Pointer move/up for drag + resize
  useEffect(() => {
    if (!open) return;

    const onMove = (e: PointerEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        setBounds(clamp(
          { ...dragRef.current.bounds, left: dragRef.current.bounds.left + dx, top: dragRef.current.bounds.top + dy },
          minWidth, minHeight,
        ));
        return;
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.startX;
        const dy = e.clientY - resizeRef.current.startY;
        setBounds(clamp(
          {
            ...resizeRef.current.bounds,
            width:  resizeRef.current.bounds.width  + dx,
            height: resizeRef.current.bounds.height + dy,
          },
          minWidth, minHeight,
        ));
      }
    };

    const onUp = () => {
      dragRef.current   = null;
      resizeRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, [open, minWidth, minHeight]);

  if (!open) return null;

  const onSurfacePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Don't drag when clicking interactive children
    if ((e.target as HTMLElement).closest("button, input, textarea, a, [role=progressbar]")) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, bounds };
  };

  const onResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, bounds };
  };

  return createPortal(
    <div
      className={`mini-float${className ? ` ${className}` : ""}`}
      style={{ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }}
      onPointerDown={onSurfacePointerDown}
    >
      {children}
      <div className="mini-float-resize-se" onPointerDown={onResizePointerDown} />
    </div>,
    document.body,
  );
}
