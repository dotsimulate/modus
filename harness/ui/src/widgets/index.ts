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
  UiIntent,
  UiIntentType,
  UiIntentOf,
  UiIntentObserver,
  UiIntentHook,
  UiIntentCapability,
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
  ScopeBinding,
} from "./types";

// Chrome context
export { WidgetChromeContext, useWidgetChrome } from "./chrome";

// Layout helpers
export { normalizePanelLayout } from "./layout";

// Intent helpers
export {
  dispatchUiIntent,
  useUiIntent,
  moveAttachResultToIntent,
  moveActivationResultToIntent,
  normalizeIntentCapability,
  getWidgetIntentCapabilities,
  widgetHandlesIntent,
  widgetHandlesUiIntent,
  getPanelIntentCapabilities,
  panelHandlesIntent,
  panelHandlesUiIntent,
} from "./intents";

// Registry
export { WIDGETS, WIDGET_DEFS, DEFAULT_DASHBOARD } from "./registry";
