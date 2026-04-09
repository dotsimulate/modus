import type { ComponentType } from "react";
import type { View } from "../views";

// ── Shared types ──

export type WidgetSize = "full" | "half" | "third";
export type DashboardModule = Extract<View, "actions" | "git">;
export type WidgetZone = "dashboard" | "left-panel" | "right-panel";

/** Base fields every widget config has (widget files extend this) */
export type WidgetBase = {
  /** Stable instance id for persisted UI state and future layout controls */
  id?: string;
  type: string;
  title?: string;
  size?: WidgetSize;
  collapsed?: boolean;
};

/** Scoped read/write handle into page-level shared state */
export type PageContextHandle = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
};

/** Props passed to every widget component */
export type WidgetProps<C extends WidgetBase = WidgetBase> = {
  config: C;
  widgetId: string;
  active?: boolean;
  onNavigate: (view: View) => void;
  onSelectSession: (id: string) => void;
  pageContext?: PageContextHandle;
};

/** What a widget registration entry looks like */
export type WidgetDef = {
  type: string;
  component: ComponentType<WidgetProps<any>>;
  /** Compact variant for dense dashboards / small panels */
  miniComponent?: ComponentType<WidgetProps<any>>;
  zones?: WidgetZone[];
  /** Minimum height in px when rendered in list mode */
  minHeight?: number;
  /** Maximum height in px when rendered in list mode */
  maxHeight?: number;
  /** Preferred default height in px for list mode */
  preferredHeight?: number;
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

export type PagePanelItem =
  | { kind: "widget"; widget: WidgetBase };

export type LayoutLeaf = {
  kind: "widget";
  id?: string;
  widget: WidgetBase;
  /** Map widget output keys → page context keys */
  publish?: Record<string, string>;
  /** Map widget input keys ← page context keys */
  subscribe?: Record<string, string>;
};

export type LayoutNode =
  | {
      kind: "grid";
      id?: string;
      columns: number;
      gap?: number;
      templateColumns?: string[];
      templateRows?: string[];
      children: LayoutNode[];
    }
  | {
      kind: "split";
      id?: string;
      axis: "horizontal" | "vertical";
      sizes?: number[];
      children: LayoutNode[];
    }
  | {
      kind: "tabs";
      id?: string;
      title?: string;
      activeTab?: string;
      columnSpan?: number;
      rowSpan?: number;
      children: LayoutLeaf[];
    }
  | {
      kind: "list";
      id?: string;
      title?: string;
      columnSpan?: number;
      rowSpan?: number;
      children: LayoutLeaf[];
    }
  | LayoutLeaf;

/** @deprecated Use LayoutLeaf */
export type PanelLeaf = LayoutLeaf;

/** @deprecated Use LayoutNode */
export type PanelNode = LayoutNode;

/** @deprecated Use LayoutNode */
export type PageLayoutNode = LayoutNode;

export type DashboardPage = {
  id: string;
  title: string;
  blocks?: DashboardBlock[];
  layout?: PageLayoutNode;
  padding?: number;
};

/** Dashboard config shape (on UserProfile.dashboard) */
export type DashboardConfig = {
  pages?: DashboardPage[];
  widgets?: WidgetBase[];
};
