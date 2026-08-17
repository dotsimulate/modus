import type { ComponentType } from "react";
import type { MoveWidgetInfo } from "../../../sdk/index";
import type { View } from "../views";

// ── Shared types ──

export type WidgetSize = "full" | "half" | "third";
export type DashboardModule = "actions" | "git";
export type WidgetZone = "dashboard" | "left-panel" | "right-panel";

export type UiIntent =
  | { type: "open-file"; path: string; line?: number; endLine?: number; edit?: boolean; highlight?: boolean; source?: string; target?: string }
  | { type: "open-terminal"; ownerType: string; ownerName: string; label?: string; target?: string }
  | { type: "focus-widget"; widgetId?: string; widgetType?: string; target?: string }
  | { type: "focus-tab"; tabId: string; target?: string }
  | { type: "open-move"; id: string; label: string; widget: MoveWidgetInfo; apiToken: string; instanceId: string; sessionId: string; mountedOnAttach?: boolean; target?: string }
  | { type: "close-move"; id: string; target?: string }
  | { type: "select-session"; sessionId: string; target?: string }
  | { type: "expand-target"; target?: string }
  | { type: "custom"; name: string; payload?: unknown; target?: string };

export type UiIntentType = UiIntent["type"];
export type UiIntentOf<T extends UiIntentType> = Extract<UiIntent, { type: T }>;
export type UiIntentObserver = (event: UiIntent) => void;

export type UiIntentHook =
  | "focus"
  | "expand"
  | "activate"
  | "open"
  | "append-dynamic-tab"
  | "replace-content";

export type UiIntentCapability = {
  /** Intent type this surface can receive. */
  type: UiIntentType;
  /** Optional routing key for targeting a named panel/widget. */
  target?: string;
  /**
   * Declarative behavior hints for future routers. Current code only records
   * them; handlers still own concrete behavior until routing is centralized.
   */
  hooks?: UiIntentHook[];
};

/** Base fields every widget config has (widget files extend this) */
export type WidgetBase = {
  /** Stable instance id for persisted UI state and future layout controls */
  id?: string;
  type: string;
  title?: string;
  size?: WidgetSize;
  collapsed?: boolean;
  /** UI intents this widget instance declares it can receive. */
  handles?: Array<UiIntentType | UiIntentCapability>;
};

/** Event payload for the page/scope event bus */
export type ScopeEvent = UiIntent;

/** Scoped read/write handle into page-level shared state */
export type PageContextHandle = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  /** Emit an event on the scope's event bus. Target panels receive matching events. */
  emit: (event: ScopeEvent) => void;
  /** Subscribe to events on the scope's event bus. Returns an unsubscribe function. */
  on: <T extends UiIntentType>(type: T, handler: (event: UiIntentOf<T>) => void) => () => void;
  /** Observe every UI intent in this page scope. Returns an unsubscribe function. */
  observeIntents: (handler: UiIntentObserver) => () => void;
  /**
   * Navigate to a top-level view. Only available when the leaf config
   * sets `canNavigate: true` — otherwise undefined (stay on page).
   */
  navigate?: (view: string) => void;
  /**
   * Select a session and navigate to it. Only available when the leaf
   * config sets `canNavigate: true` — otherwise undefined (stay on page).
   */
  selectSession?: (id: string) => void;
  /**
   * Activate a session and navigate to the chat view. Available to all
   * page-embedded widgets — use when creating a new session that should
   * immediately open the composer.
   */
  activateSession?: (id: string) => void;
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

/** One configurable key on a widget, for the generated catalog and the linter. */
export type WidgetConfigKey = {
  /** Key name as written in page JSON, e.g. "blocks". */
  name: string;
  /** Human-readable type, e.g. `("prompt"|"text")[]` or `number`. */
  type: string;
  /** What setting it does. One line. */
  description: string;
};

/**
 * Everything about a widget except the React component.
 *
 * Split out of `WidgetDef` so it can be imported without pulling in fifty
 * component trees — the page linter, the docs generator, and their tests all
 * need this metadata and none of them can afford React, CodeMirror, or xterm
 * at module scope.
 */
export type WidgetMeta = {
  type: string;
  /**
   * What this widget is, in one or two sentences, aimed at somebody deciding
   * whether to put it on a page. Absent means nobody has written one yet —
   * the generated catalog reports that rather than inventing a description.
   */
  description?: string;
  /** Config keys beyond `WidgetBase`, for page authors. */
  config?: WidgetConfigKey[];
  zones?: WidgetZone[];
  /** Minimum height in px when rendered in list mode */
  minHeight?: number;
  /**
   * Maximum height in px when rendered in list mode.
   *
   * Also the only declared bound on how large a widget can get, so the page
   * linter reads it as "safe to place in a split child sized `auto`" — an
   * `auto` child is `flex: 0 0 auto` with `min-height: auto`, which cannot
   * shrink and will claim its content's full extent forever.
   */
  maxHeight?: number;
  /** Preferred default height in px for list mode */
  preferredHeight?: number;
  /** Default UI intents supported by this widget type. */
  handles?: Array<UiIntentType | UiIntentCapability>;
};

/** What a widget registration entry looks like */
export type WidgetDef = WidgetMeta & {
  component: ComponentType<WidgetProps<any>>;
  /** Compact variant for dense dashboards / small panels */
  miniComponent?: ComponentType<WidgetProps<any>>;
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
  /**
   * When true, the widget's pageContext includes `navigate()` and
   * `selectSession()` — allowing it to leave the current page.
   * Default: false (widget stays on the page, publishes to the bus).
   */
  canNavigate?: boolean;
  /**
   * Conditional visibility based on page context state.
   * Keys are page context keys; values are the expected state.
   * `null` matches null/undefined. All conditions must match (AND).
   *
   * Example: `{ "activeSessionId": null }` → show only when no session is selected.
   */
  showWhen?: Record<string, unknown>;
  /**
   * Inverse of showWhen. Hide the widget when conditions match.
   * Any single match hides the widget (OR).
   *
   * Example: `{ "activeSessionId": null }` → hide when no session is selected.
   */
  hideWhen?: Record<string, unknown>;
};

/** Conditional visibility fields shared by all layout nodes */
type LayoutVisibility = {
  /** Show when all page context conditions match (AND). `null` matches null/undefined. */
  showWhen?: Record<string, unknown>;
  /** Hide when any page context condition matches (OR). `null` matches null/undefined. */
  hideWhen?: Record<string, unknown>;
};

export type ScopeBinding = {
  /** Key in this (child) scope's context bus */
  local: string;
  /** Key in the parent scope's context bus */
  parent: string;
  /** Sync direction: child→parent, parent→child, or both */
  direction: "up" | "down" | "twoWay";
};

export type LayoutNode =
  | ({
      kind: "grid";
      id?: string;
      columns: number;
      gap?: number;
      templateColumns?: string[];
      templateRows?: string[];
      children: LayoutNode[];
    } & LayoutVisibility)
  | ({
      kind: "split";
      id?: string;
      axis: "horizontal" | "vertical";
      /**
       * Per-child flex weight. Numbers are flex proportions (e.g. [1, 3] → 25%/75%).
       * Use "auto" for children that should size to their content (flex: 0 0 auto).
       */
      sizes?: (number | "auto")[];
      /** Per-child collapsibility. When true, a collapse tab appears on the inner edge. */
      collapsible?: boolean[];
      children: LayoutNode[];
    } & LayoutVisibility)
  | ({
      kind: "tabs";
      id?: string;
      title?: string;
      activeTab?: string;
      columnSpan?: number;
      rowSpan?: number;
      /** When true, shows a widget picker (+) to add/remove/reorder widgets at runtime. */
      editable?: boolean;
      /**
       * When true, this panel receives dynamic tab events from its scope's event bus.
       * Events like "open-move" (move widget attached) and "open-file" (file clicked)
       * cause new tabs to appear in this panel automatically.
       */
      target?: boolean;
      /** UI intents this panel can route to its children or dynamic surface. */
      handles?: Array<UiIntentType | UiIntentCapability>;
      children: LayoutLeaf[];
    } & LayoutVisibility)
  | ({
      kind: "list";
      id?: string;
      title?: string;
      columnSpan?: number;
      rowSpan?: number;
      /** When true, shows a widget picker (+) to add/remove/reorder widgets at runtime. */
      editable?: boolean;
      /** When true, this panel receives dynamic tab events from its scope's event bus. */
      target?: boolean;
      /** UI intents this panel can route to its children or dynamic surface. */
      handles?: Array<UiIntentType | UiIntentCapability>;
      children: LayoutLeaf[];
    } & LayoutVisibility)
  | ({
      /**
       * Scope — creates an isolated context bus for its subtree.
       * Widgets inside share state and events independently from the outer page.
       * Enables multi-session pages where each scope tracks its own session.
       */
      kind: "scope";
      id?: string;
      /** Initial state for this scope's context bus (e.g. { "sessionId": null }) */
      context?: Record<string, unknown>;
      /**
       * Explicit bindings between this child scope's local keys and the parent
       * scope's keys. Enables multi-scope pages where isolated child scopes
       * export selected state to a shared parent (e.g. two session panes
       * exporting their sessionId as leftSessionId / rightSessionId).
       */
      bindings?: ScopeBinding[];
      /**
       * When true, mirrors this scope's `sessionId` with the URL hash session id.
       * Inbound: hash session id on mount + on hashchange is pushed into the bus.
       * Outbound: bus `sessionId` changes call `onSelectSession`, which updates the URL.
       * Only one scope per page should enable this.
       */
      bindUrlSession?: boolean;
      /** The layout subtree that shares this scope's context */
      children: LayoutNode[];
    } & LayoutVisibility)
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
  layouts?: {
    mobile?: PageLayoutNode;
  };
  padding?: number;
  nav?: boolean;
  fullscreen?: boolean;
};

/** Dashboard config shape (on UserProfile.dashboard) */
export type DashboardConfig = {
  pages?: DashboardPage[];
  widgets?: WidgetBase[];
};
