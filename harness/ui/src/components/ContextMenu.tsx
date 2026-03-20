/**
 * ContextMenu — generic right-click context menu component.
 *
 * Renders a positioned menu of items with optional separators.
 * Closes on click outside, Escape, or item selection.
 */

import { useEffect, useRef, useCallback, type ReactNode } from "react";

export type ContextMenuItem =
  | { kind: "action"; label: string; icon?: ReactNode; disabled?: boolean; onClick: () => void }
  | { kind: "separator" }
  | { kind: "submenu"; label: string; icon?: ReactNode; items: ContextMenuItem[] };

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Adjust position so menu stays on-screen
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    if (rect.right > window.innerWidth - pad) {
      el.style.left = `${Math.max(pad, x - rect.width)}px`;
    }
    if (rect.bottom > window.innerHeight - pad) {
      el.style.top = `${Math.max(pad, y - rect.height)}px`;
    }
  }, [x, y]);

  // Close on click outside or Escape
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay listener so the opening right-click doesn't immediately close
    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    });
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  const handleItemClick = useCallback((item: ContextMenuItem) => {
    if (item.kind === "action" && !item.disabled) {
      item.onClick();
      onClose();
    }
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      style={{ left: x, top: y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.kind === "separator") {
          return <div key={i} className="ctx-menu-sep" />;
        }
        if (item.kind === "submenu") {
          return <ContextSubmenu key={i} item={item} onAction={onClose} />;
        }
        return (
          <button
            key={i}
            className={`ctx-menu-item${item.disabled ? " ctx-menu-item--disabled" : ""}`}
            onClick={() => handleItemClick(item)}
            disabled={item.disabled}
          >
            {item.icon && <span className="ctx-menu-item-icon">{item.icon}</span>}
            <span className="ctx-menu-item-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ContextSubmenu({ item, onAction }: { item: Extract<ContextMenuItem, { kind: "submenu" }>; onAction: () => void }) {
  return (
    <div className="ctx-menu-submenu">
      <div className="ctx-menu-item ctx-menu-item--submenu">
        {item.icon && <span className="ctx-menu-item-icon">{item.icon}</span>}
        <span className="ctx-menu-item-label">{item.label}</span>
        <span className="ctx-menu-item-arrow">
          <svg width="6" height="8" viewBox="0 0 6 8" fill="none">
            <path d="M1 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </div>
      <div className="ctx-menu ctx-menu--sub">
        {item.items.map((sub, i) => {
          if (sub.kind === "separator") return <div key={i} className="ctx-menu-sep" />;
          if (sub.kind === "action") {
            return (
              <button
                key={i}
                className={`ctx-menu-item${sub.disabled ? " ctx-menu-item--disabled" : ""}`}
                onClick={() => { if (!sub.disabled) { sub.onClick(); onAction(); } }}
                disabled={sub.disabled}
              >
                {sub.icon && <span className="ctx-menu-item-icon">{sub.icon}</span>}
                <span className="ctx-menu-item-label">{sub.label}</span>
              </button>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ── Helper to create a portal-based context menu state hook ──

import { useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
} | null;

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>(null);

  const open = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  const portal = menu
    ? createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />,
        document.body,
      )
    : null;

  return { open, close, portal, isOpen: menu !== null };
}
