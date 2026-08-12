/**
 * ContextMenu — generic right-click context menu component.
 *
 * Renders a positioned menu of items with optional separators.
 * Closes on click outside, Escape, or item selection.
 */

import { useEffect, useRef, useCallback, useState, type ReactNode } from "react";

/**
 * Status tint for an item's leading dot. Values map onto the shared
 * `.dash-dot--*` classes so a menu row reads the same as a sidebar row.
 */
export type ContextMenuStatus = "running" | "done" | "error";

export type ContextMenuItem =
  | {
      kind: "action";
      label: string;
      /** Optional second line, rendered muted beneath the label. */
      detail?: string;
      /** Right-aligned trailing text (timestamps, counts). */
      meta?: string;
      /** Leading status dot. Omit for a normal item. */
      status?: ContextMenuStatus;
      icon?: ReactNode;
      disabled?: boolean;
      onClick: () => void;
    }
  | { kind: "separator" }
  | {
      kind: "submenu";
      label: string;
      icon?: ReactNode;
      /**
       * Either a fixed list, or a loader invoked the first time the submenu is
       * opened. The loader runs at most once per mounted menu; its result is
       * cached for the life of the menu.
       */
      items: ContextMenuItem[] | (() => Promise<ContextMenuItem[]>);
      /** Shown while a loader is in flight. */
      loadingLabel?: string;
      /** Shown when a loader resolves to an empty list. */
      emptyLabel?: string;
    };

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

  return (
    <>
      <div className="ctx-menu-backdrop" onPointerDown={onClose} aria-hidden="true" />
      <div
        ref={menuRef}
        className="ctx-menu ctx-menu--root"
        style={{ left: x, top: y }}
        role="menu"
        onContextMenu={(e) => e.preventDefault()}
      >
        <ContextMenuItems items={items} onAction={onClose} />
      </div>
    </>
  );
}

/**
 * Renders one level of items. Recursive, so a submenu may itself contain
 * submenus — the previous implementation dropped anything nested.
 */
function ContextMenuItems({ items, onAction }: { items: ContextMenuItem[]; onAction: () => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "separator") return <div key={i} className="ctx-menu-sep" />;
        if (item.kind === "submenu") return <ContextSubmenu key={i} item={item} onAction={onAction} />;
        return <ContextMenuAction key={i} item={item} onAction={onAction} />;
      })}
    </>
  );
}

function ContextMenuAction({ item, onAction }: { item: Extract<ContextMenuItem, { kind: "action" }>; onAction: () => void }) {
  const rich = item.detail != null || item.meta != null || item.status != null;
  return (
    <button
      className={`ctx-menu-item${item.disabled ? " ctx-menu-item--disabled" : ""}${rich ? " ctx-menu-item--rich" : ""}`}
      onClick={() => { if (!item.disabled) { item.onClick(); onAction(); } }}
      disabled={item.disabled}
      title={item.detail ? `${item.label} — ${item.detail}` : item.label}
    >
      {item.status && <span className={`dash-dot dash-dot--${item.status}`} />}
      {item.icon && <span className="ctx-menu-item-icon">{item.icon}</span>}
      <span className="ctx-menu-item-body">
        <span className="ctx-menu-item-label">{item.label}</span>
        {item.detail && <span className="ctx-menu-item-detail">{item.detail}</span>}
      </span>
      {item.meta && <span className="ctx-menu-item-meta">{item.meta}</span>}
    </button>
  );
}

type SubmenuState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; items: ContextMenuItem[] }
  | { phase: "error" };

function ContextSubmenu({ item, onAction }: { item: Extract<ContextMenuItem, { kind: "submenu" }>; onAction: () => void }) {
  const isStatic = Array.isArray(item.items);
  const [state, setState] = useState<SubmenuState>(
    isStatic ? { phase: "ready", items: item.items as ContextMenuItem[] } : { phase: "idle" },
  );
  const [expanded, setExpanded] = useState(false);
  const subRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // Flip the flyout to the left / upward when it would leave the viewport. The
  // root menu's own repositioning does not reach nested panels.
  const positionFlyout = useCallback(() => {
    const el = subRef.current;
    if (!el) return;
    el.style.left = "";
    el.style.right = "";
    el.style.top = "";
    el.style.bottom = "";
    const rect = el.getBoundingClientRect();
    const pad = 8;
    if (rect.right > window.innerWidth - pad) {
      el.style.left = "auto";
      el.style.right = "100%";
    }
    if (rect.bottom > window.innerHeight - pad) {
      el.style.top = "auto";
      el.style.bottom = `${-pad / 2}px`;
    }
  }, []);

  // Load once, on first open, and re-measure whenever the flyout becomes
  // visible or its contents change. The flyout is display:none until hover, so
  // it has no measurable box before then — positioning has to happen here and
  // not on mount. React StrictMode double-invokes effects, so the load guard is
  // a ref rather than state.
  const handleOpen = useCallback(() => {
    requestAnimationFrame(positionFlyout);
    if (isStatic || startedRef.current) return;
    startedRef.current = true;
    setState({ phase: "loading" });
    (item.items as () => Promise<ContextMenuItem[]>)()
      .then((loaded) => { if (aliveRef.current) setState({ phase: "ready", items: loaded }); })
      .catch(() => { if (aliveRef.current) setState({ phase: "error" }); });
  }, [isStatic, item, positionFlyout]);

  useEffect(() => {
    if (state.phase === "ready" || state.phase === "loading") {
      requestAnimationFrame(positionFlyout);
    }
  }, [state, positionFlyout]);

  const body = () => {
    if (state.phase === "loading") {
      return <div className="ctx-menu-note">{item.loadingLabel ?? "loading"}<span className="ctx-menu-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></div>;
    }
    if (state.phase === "error") return <div className="ctx-menu-note">could not load</div>;
    if (state.phase === "idle") return null;
    if (state.items.length === 0) return <div className="ctx-menu-note">{item.emptyLabel ?? "nothing here"}</div>;
    return <ContextMenuItems items={state.items} onAction={onAction} />;
  };

  const handleToggle = () => {
    handleOpen();
    setExpanded((value) => !value);
  };

  return (
    <div
      className={`ctx-menu-submenu${expanded ? " ctx-menu-submenu--open" : ""}`}
      onMouseEnter={handleOpen}
      onFocus={handleOpen}
      onPointerEnter={handleOpen}
    >
      <button
        className="ctx-menu-item ctx-menu-item--submenu"
        type="button"
        aria-haspopup="menu"
        aria-expanded={expanded}
        onClick={handleToggle}
      >
        {item.icon && <span className="ctx-menu-item-icon">{item.icon}</span>}
        <span className="ctx-menu-item-label">{item.label}</span>
        <span className="ctx-menu-item-arrow">
          <svg width="6" height="8" viewBox="0 0 6 8" fill="none">
            <path d="M1 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </button>
      <div className="ctx-menu ctx-menu--sub" ref={subRef}>
        {body()}
      </div>
    </div>
  );
}

// ── Helper to create a portal-based context menu state hook ──

import { createPortal } from "react-dom";

export type ContextMenuState = {
  x: number;
  y: number;
  items: ContextMenuItem[];
} | null;

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState>(null);

  const openAt = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setMenu({ x, y, items });
  }, []);

  const open = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    openAt(e.clientX, e.clientY, items);
  }, [openAt]);

  const openFromElement = useCallback((element: HTMLElement, items: ContextMenuItem[]) => {
    const rect = element.getBoundingClientRect();
    openAt(rect.right, rect.bottom + 2, items);
  }, [openAt]);

  const close = useCallback(() => setMenu(null), []);

  const portal = menu
    ? createPortal(
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />,
        document.body,
      )
    : null;

  return { open, openAt, openFromElement, close, portal, isOpen: menu !== null };
}
