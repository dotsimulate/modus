import { useEffect, useRef, useState } from "react";
import type { View } from "../views";
import {
  isPageEnabled,
  movePageKey,
  normalizePageNavPrefs,
  removeKey,
  resolvePageNav,
  upsertOrderedKey,
  type PageNavItem,
  type PageNavPrefs,
} from "../pageNav";

type Variant = "compact" | "manager";

type Props = {
  pages: PageNavItem[];
  activeView: View;
  prefs: PageNavPrefs;
  canEdit?: boolean;
  variant: Variant;
  onNavigate: (view: View) => void;
  onPrefsChange?: (prefs: PageNavPrefs) => void | Promise<void>;
  onFork?: (page: PageNavItem) => void | Promise<void>;
  forkingKey?: string | null;
};

const ORIGIN_LABELS: Record<string, string> = {
  standalone: "project",
  harness: "harness",
  move: "moves",
  action: "actions",
  mission: "missions",
  profile: "profile",
};

export function PagePicker({
  pages,
  activeView,
  prefs,
  canEdit = true,
  variant,
  onNavigate,
  onPrefsChange,
  onFork,
  forkingKey,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const resolved = resolvePageNav(pages, prefs);
  const normalized = normalizePageNavPrefs(prefs);
  const activePage = pages.find((page) => page.view === activeView);
  const pinnedKeys = new Set(resolved.pinned.map((page) => page.key));

  useEffect(() => {
    if (variant !== "compact" || !open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open, variant]);

  useEffect(() => {
    if (variant !== "compact" || !open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [open, variant]);

  const save = (next: PageNavPrefs) => {
    if (!canEdit) return;
    void onPrefsChange?.(normalizePageNavPrefs(next));
  };

  const toggleEnabled = (page: PageNavItem) => {
    const currentlyEnabled = isPageEnabled(page, normalized);
    const disabled = currentlyEnabled
      ? upsertOrderedKey(normalized.disabled, page.key)
      : removeKey(normalized.disabled, page.key);
    const enabled = !currentlyEnabled && !page.navDefault
      ? upsertOrderedKey(normalized.enabled, page.key)
      : removeKey(normalized.enabled, page.key);
    const pinned = currentlyEnabled ? removeKey(normalized.pinned, page.key) : normalized.pinned;
    const order = currentlyEnabled ? normalized.order : upsertOrderedKey(normalized.order, page.key);
    save({ ...normalized, enabled, disabled, pinned, order });
  };

  const togglePinned = (page: PageNavItem) => {
    const currentPinned = normalized.pinned.length > 0
      ? normalized.pinned
      : resolved.pinned.map((item) => item.key);
    const isPinned = currentPinned.includes(page.key);
    const pinned = isPinned ? removeKey(currentPinned, page.key) : upsertOrderedKey(currentPinned, page.key);
    const enabled = isPageEnabled(page, normalized) || page.navDefault
      ? normalized.enabled
      : upsertOrderedKey(normalized.enabled, page.key);
    const disabled = removeKey(normalized.disabled, page.key);
    const order = upsertOrderedKey(normalized.order, page.key);
    save({ ...normalized, enabled, disabled, pinned, order });
  };

  const movePage = (page: PageNavItem, direction: -1 | 1) => {
    const baseOrder = normalized.order.length > 0
      ? normalized.order
      : resolved.all.map((item) => item.key);
    save({ ...normalized, order: movePageKey(baseOrder, page.key, direction) });
  };

  const openPage = (page: PageNavItem) => {
    onNavigate(page.view);
    setOpen(false);
  };

  if (variant === "compact") {
    const quickPages = filterPages(resolved.enabled, query);
    const managePage = pages.find((page) => page.key === "page:pages");
    const triggerLabel = activePage?.label ?? "pages";
    return (
      <div className="page-picker page-picker--compact" ref={ref}>
        <button
          type="button"
          className={`page-picker-trigger${open ? " page-picker-trigger--open" : ""}`}
          onClick={() => setOpen((value) => !value)}
          title="Open page picker"
        >
          <span className="page-picker-trigger-label">{triggerLabel}</span>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M2 3l2 2 2-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="page-picker-popover">
            <div className="page-picker-search-row">
              <input
                className="page-picker-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="filter pages"
                autoFocus
              />
            </div>
            <div className="page-picker-quick-list">
              {quickPages.length === 0 && <div className="page-picker-empty">no enabled pages</div>}
              {quickPages.map((page) => (
                <button
                  key={page.key}
                  type="button"
                  className={`page-picker-quick-item${page.view === activeView ? " page-picker-quick-item--active" : ""}`}
                  onClick={() => openPage(page)}
                  title={page.title}
                >
                  <span className="page-picker-quick-title">{page.label}</span>
                  <span className="page-picker-origin">{ORIGIN_LABELS[page.origin] ?? page.origin}</span>
                </button>
              ))}
            </div>
            {managePage && (
              <button type="button" className="page-picker-manage" onClick={() => openPage(managePage)}>
                manage pages
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const managerPages = filterPages(resolved.all, query);
  const grouped = groupPages(managerPages);

  return (
    <div className="page-picker page-picker--manager">
      <div className="page-picker-search-wrap">
        <input
          className="page-picker-search page-picker-search--manager"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="filter pages"
        />
        {query && (
          <button type="button" className="page-picker-search-clear" onClick={() => setQuery("")}>
            ×
          </button>
        )}
      </div>
      {managerPages.length === 0 && <div className="page-picker-empty">no pages match</div>}
      {Object.entries(grouped).map(([origin, items]) => (
        <div key={origin} className="page-picker-group">
          <div className="page-picker-group-header">
            <span>{ORIGIN_LABELS[origin] ?? origin}</span>
            <span>{items.length}</span>
          </div>
          <div className="page-picker-manager-list">
            {items.map((page) => {
              const enabled = isPageEnabled(page, normalized);
              const pinned = pinnedKeys.has(page.key);
              return (
                <div key={page.key} className={`page-picker-row${enabled ? "" : " page-picker-row--disabled"}`}>
                  <button
                    type="button"
                    className={`page-picker-row-toggle${enabled ? " page-picker-row-toggle--on" : ""}`}
                    onClick={() => toggleEnabled(page)}
                    disabled={!canEdit}
                    title={enabled ? "Disable page" : "Enable page"}
                  >
                    {enabled ? "shown" : "show"}
                  </button>
                  <button
                    type="button"
                    className="page-picker-row-main"
                    onClick={() => openPage(page)}
                    title={page.title}
                  >
                    <span className="page-picker-row-title">{page.label}</span>
                    <span className="page-picker-row-id">{page.key}</span>
                  </button>
                  <div className="page-picker-row-meta">
                    {page.widgetCount ? <span>{page.widgetCount} widget{page.widgetCount === 1 ? "" : "s"}</span> : null}
                  </div>
                  <div className="page-picker-row-actions">
                    <button
                      type="button"
                      className={`page-picker-pin${pinned ? " page-picker-pin--on" : ""}`}
                      onClick={() => togglePinned(page)}
                      disabled={!canEdit}
                      title={pinned ? "Unpin from top nav" : "Pin to top nav"}
                    >
                      {pinned ? "pinned" : "pin"}
                    </button>
                    <button type="button" className="page-picker-move" onClick={() => movePage(page, -1)} disabled={!canEdit} title="Move up">↑</button>
                    <button type="button" className="page-picker-move" onClick={() => movePage(page, 1)} disabled={!canEdit} title="Move down">↓</button>
                    <button type="button" className="page-picker-open" onClick={() => openPage(page)}>
                      open
                    </button>
                    {page.canFork && onFork && (
                      <button
                        type="button"
                        className="page-picker-fork"
                        onClick={() => void onFork(page)}
                        disabled={forkingKey === page.key}
                      >
                        {forkingKey === page.key ? "forking..." : "fork"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function filterPages(pages: PageNavItem[], query: string): PageNavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return pages;
  return pages.filter((page) => {
    return page.label.toLowerCase().includes(q)
      || page.title.toLowerCase().includes(q)
      || page.key.toLowerCase().includes(q)
      || page.origin.toLowerCase().includes(q);
  });
}

function groupPages(pages: PageNavItem[]): Record<string, PageNavItem[]> {
  const groups: Record<string, PageNavItem[]> = {};
  for (const page of pages) {
    groups[page.origin] ??= [];
    groups[page.origin].push(page);
  }
  return groups;
}
