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
export type DashboardModule = Extract<View, "actions" | "git">;

/** Base fields every widget config has (widget files extend this) */
export type WidgetBase = {
  /** Stable instance id for persisted UI state and future layout controls */
  id?: string;
  type: string;
  title?: string;
  size?: WidgetSize;
  collapsed?: boolean;
};

/** Props passed to every widget component */
export type WidgetProps<C extends WidgetBase = WidgetBase> = {
  config: C;
  widgetId: string;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
};

/** What a widget file's default export looks like */
export type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
};

export type DashboardWidgetBlock = {
  kind: "widget";
  widget: WidgetBase;
};

export type DashboardModuleBlock = {
  kind: "module";
  id?: string;
  title?: string;
  size?: WidgetSize;
  module: DashboardModule;
  collapsed?: boolean;
};

export type DashboardTextBlock = {
  kind: "text";
  id?: string;
  title?: string;
  size?: WidgetSize;
  markdown: string;
  collapsed?: boolean;
};

export type DashboardBlock =
  | DashboardWidgetBlock
  | DashboardModuleBlock
  | DashboardTextBlock;

export type DashboardPage = {
  id: string;
  title: string;
  blocks: DashboardBlock[];
};

/** Dashboard config shape (on UserProfile.dashboard) */
export type DashboardConfig = {
  pages?: DashboardPage[];
  widgets?: WidgetBase[];
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
  widgets: [
    {
      id: "project-theme-main",
      type: "project-theme",
      title: "project theme",
      size: "full",
    } as WidgetBase,
    {
      id: "claude-pricing-main",
      type: "claude-pricing",
      size: "full",
    } as WidgetBase,
    {
      id: "deep-analytics-main",
      type: "deep-analytics",
      title: "deep analytics",
      size: "full",
    } as WidgetBase,
    {
      id: "sessions-main",
      type: "sessions",
      size: "full",
      limit: 5,
    } as WidgetBase,
  ],
};
