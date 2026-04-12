/**
 * Widget system barrel — re-exports from split modules.
 *
 * Types, chrome context, layout helpers, and registry are each in
 * their own module with clean Fast Refresh boundaries.
 */

// Types
export type {
  WidgetSize,
  DashboardModule,
  WidgetZone,
  WidgetBase,
  WidgetProps,
  WidgetDef,
  DashboardWidgetBlock,
  DashboardModuleBlock,
  DashboardTextBlock,
  DashboardBlock,
  PagePanelItem,
  LayoutLeaf,
  LayoutNode,
  PanelLeaf,
  PanelNode,
  PageLayoutNode,
  DashboardPage,
  DashboardConfig,
  PageContextHandle,
  ScopeEvent,
} from "./types";

// Chrome context
export { WidgetChromeContext, useWidgetChrome } from "./chrome";

// Layout helpers
export { normalizePanelLayout } from "./layout";

// Registry
export { WIDGETS, WIDGET_DEFS, DEFAULT_DASHBOARD } from "./registry";
