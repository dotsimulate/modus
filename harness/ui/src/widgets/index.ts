/**
 * Widget registry — auto-discovers *.widget.tsx files in this directory.
 *
 * To add a new widget:
 *   1. Create widgets/my-thing.widget.tsx
 *   2. Export default: { type: "my-thing", component: MyThingWidget }
 *   That's it. Vite's import.meta.glob picks it up automatically.
 */

import type { ComponentType } from "react";
import type { View } from "../views";

// ── Shared types ──

export type WidgetSize = "full" | "half" | "third";

/** Base fields every widget config has (widget files extend this) */
export type WidgetBase = {
  type: string;
  title?: string;
  size?: WidgetSize;
  collapsed?: boolean;
};

/** Props passed to every widget component */
export type WidgetProps<C extends WidgetBase = WidgetBase> = {
  config: C;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
};

/** What a widget file's default export looks like */
export type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
};

/** Dashboard config shape (on UserProfile.dashboard) */
export type DashboardConfig = {
  widgets: WidgetBase[];
};

// ── Auto-discovery ──

const modules = import.meta.glob<{ default: WidgetDef }>(
  "./*.widget.tsx",
  { eager: true },
);

export const WIDGETS: Record<string, ComponentType<WidgetProps<any>>> = {};

for (const mod of Object.values(modules)) {
  if (mod.default?.type && mod.default?.component) {
    WIDGETS[mod.default.type] = mod.default.component;
  }
}

/** Default dashboard when user profile has no dashboard config */
export const DEFAULT_DASHBOARD: DashboardConfig = {
  widgets: [{ type: "account" }, { type: "stats" }, { type: "sessions" }],
};
