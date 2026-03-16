import { useCallback, useRef } from "react";

type Props = {
  /** "left" = dragging adjusts the element to the left, "right" = adjusts the element to the right */
  side: "left" | "right";
  onResize: (delta: number) => void;
};

export function ResizeHandle({ side, onResize }: Props) {
  const startX = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    startX.current = e.clientX;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX.current;
      startX.current = ev.clientX;
      // "left" side means the panel is on the left — drag right = grow
      // "right" side means the panel is on the right — drag left = grow
      onResize(side === "left" ? dx : -dx);
    };

    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }, [side, onResize]);

  return (
    <div
      className={`resize-handle resize-handle--${side}`}
      onPointerDown={onPointerDown}
    />
  );
}
