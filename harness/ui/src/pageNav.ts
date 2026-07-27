import type { UserProfileUiConfig } from "../../sdk/index";
import type { View } from "./views";

export type PageNavMode = "auto" | "compact" | "tabs" | "launcher";
export type PageNavPrefs = NonNullable<UserProfileUiConfig["pageNav"]>;
export type NormalizedPageNavPrefs = {
  mode: PageNavMode;
  enabled: string[];
  disabled: string[];
  pinned: string[];
  order: string[];
  labels: Record<string, string>;
};

export type PageNavOrigin = "standalone" | "plugin" | "harness" | "move" | "action" | "mission" | "profile";

export type PageNavItem = {
  key: View;
  view: View;
  id: string;
  title: string;
  label: string;
  origin: PageNavOrigin;
  navDefault: boolean;
  widgetCount?: number;
  canFork?: boolean;
};

export type ResolvedPageNav = {
  mode: PageNavMode;
  all: PageNavItem[];
  enabled: PageNavItem[];
  pinned: PageNavItem[];
};

const DEFAULT_PINNED_COUNT = 3;

export function normalizePageNavPrefs(prefs?: PageNavPrefs | null): NormalizedPageNavPrefs {
  return {
    mode: prefs?.mode ?? "auto",
    enabled: uniqueStrings(prefs?.enabled),
    disabled: uniqueStrings(prefs?.disabled),
    pinned: uniqueStrings(prefs?.pinned),
    order: uniqueStrings(prefs?.order),
    labels: pruneLabels(prefs?.labels),
  };
}

export function resolvePageNav(items: PageNavItem[], prefs?: PageNavPrefs | null): ResolvedPageNav {
  const normalized = normalizePageNavPrefs(prefs);
  const enabledKeys = new Set(normalized.enabled);
  const disabledKeys = new Set(normalized.disabled);
  const pinnedKeys = new Set(normalized.pinned);
  const hasExplicitPinned = normalized.pinned.length > 0;

  const sorted = sortByPreference(items, normalized.order).map((item) => {
    const label = normalized.labels[item.key] || normalized.labels[item.id] || item.title;
    return { ...item, label };
  });

  const enabled = sorted.filter((item) => {
    if (disabledKeys.has(item.key)) return false;
    return item.navDefault || enabledKeys.has(item.key);
  });

  const defaultPinned = enabled.slice(0, DEFAULT_PINNED_COUNT).map((item) => item.key);
  const activePinnedKeys = hasExplicitPinned ? pinnedKeys : new Set(defaultPinned);
  const pinned = enabled.filter((item) => activePinnedKeys.has(item.key));

  return {
    mode: normalized.mode ?? "auto",
    all: sorted,
    enabled,
    pinned,
  };
}

export function isPageEnabled(item: PageNavItem, prefs?: PageNavPrefs | null): boolean {
  const normalized = normalizePageNavPrefs(prefs);
  return !normalized.disabled.includes(item.key) && (item.navDefault || normalized.enabled.includes(item.key));
}

export function pageNavDirectItems(resolved: ResolvedPageNav): PageNavItem[] {
  if (resolved.mode === "launcher") return [];
  if (resolved.mode === "tabs") return resolved.enabled;
  return resolved.pinned;
}

export function upsertOrderedKey(keys: string[] | undefined, key: string): string[] {
  return [...uniqueStrings(keys).filter((existing) => existing !== key), key];
}

export function removeKey(keys: string[] | undefined, key: string): string[] {
  return uniqueStrings(keys).filter((existing) => existing !== key);
}

export function movePageKey(keys: string[] | undefined, key: string, direction: -1 | 1): string[] {
  const next = uniqueStrings(keys);
  const index = next.indexOf(key);
  if (index < 0) return next;
  const target = index + direction;
  if (target < 0 || target >= next.length) return next;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function countPageWidgets(page: { blocks?: unknown[]; layout?: unknown }): number {
  if (Array.isArray(page.blocks)) return page.blocks.length;
  if (page.layout) return countLayoutWidgets(page.layout);
  return 0;
}

function countLayoutWidgets(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  if (record.kind === "widget") return 1;
  const children = record.children;
  if (!Array.isArray(children)) return 0;
  return children.reduce<number>((sum, child) => sum + countLayoutWidgets(child), 0);
}

function sortByPreference(items: PageNavItem[], order: string[] | undefined): PageNavItem[] {
  const byKey = new Map(items.map((item) => [item.key, item]));
  const ordered: PageNavItem[] = [];
  for (const key of uniqueStrings(order)) {
    const item = byKey.get(key as View);
    if (!item) continue;
    ordered.push(item);
    byKey.delete(key as View);
  }
  return [...ordered, ...byKey.values()];
}

function uniqueStrings(values?: readonly string[]): string[] {
  if (!values) return [];
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function pruneLabels(labels?: Record<string, string>): Record<string, string> {
  if (!labels) return {};
  return Object.fromEntries(
    Object.entries(labels)
      .map(([key, value]) => [key, value.trim()] as const)
      .filter(([key, value]) => key && value),
  );
}
