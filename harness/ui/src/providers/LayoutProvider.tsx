/**
 * LayoutProvider — view-independent panel state management.
 *
 * Owns left/right panel open, width, browser path, and per-session
 * state persistence. Extracted from AppShell to decouple panels from
 * the chat view.
 */

import {
  useState, useCallback, useEffect, useRef,
  type ReactNode,
} from "react";
import { modus } from "../modusClient";
import { useProfiles } from "./ProfileContext";
import { useSession } from "./SessionContext";
import { useFileViewer } from "./FileViewerContext";
import type { View } from "../views";
import { normalizePanelLayout, type LayoutNode, type WidgetBase } from "../widgets";
import { LayoutContext } from "./LayoutContext";

// ── View-dependent panel defaults ──

type PanelDefaults = {
  left: { open: boolean; width: number; mode: "list" | "tabs"; widgets: string[] };
  right: { open: boolean; width: number; mode: "list" | "tabs"; widgets: string[] };
};

type PersistedPanelWidget = string | WidgetBase;

function normalizePanelWidgets(side: "left" | "right", widgets: PersistedPanelWidget[] | undefined): WidgetBase[] {
  return (widgets ?? []).map((widget, index) => {
    if (typeof widget === "string") {
      return { id: `${side}-${widget}-${index + 1}`, type: widget };
    }
    return {
      ...widget,
      id: widget.id?.trim() || `${side}-${widget.type}-${index + 1}`,
    };
  });
}

const VIEW_PANEL_DEFAULTS: Partial<Record<View, PanelDefaults>> = {
  chat: {
    left: { open: false, width: 280, mode: "list", widgets: ["session-list", "config-inspector", "session-info", "moves"] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor", "agent-activity", "session-edits", "session-terminal"] },
  },
  actions: {
    left: { open: false, width: 280, mode: "list", widgets: ["session-list"] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
  profiles: {
    left: { open: false, width: 280, mode: "list", widgets: ["session-list"] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
  web: {
    left: { open: false, width: 280, mode: "list", widgets: ["session-list"] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
  trace: {
    left: { open: false, width: 280, mode: "list", widgets: [] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
  git: {
    left: { open: false, width: 280, mode: "list", widgets: ["session-list"] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
  home: {
    left: { open: false, width: 280, mode: "list", widgets: [] },
    right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
  },
};

const FALLBACK_DEFAULTS: PanelDefaults = {
  left: { open: false, width: 280, mode: "list", widgets: [] },
  right: { open: false, width: 360, mode: "tabs", widgets: ["code-editor"] },
};

function getDefaults(view: View): PanelDefaults {
  return VIEW_PANEL_DEFAULTS[view] ?? FALLBACK_DEFAULTS;
}

// ── Provider ──

export function LayoutProvider({ view, children }: { view: View; children: ReactNode }) {
  const { activeUserProfile, activeUP, refreshUserProfiles } = useProfiles();
  const { activeSession } = useSession();
  const { tabs: fileViewerTabs, activePath: fileViewerActivePath, hydrate: hydrateFileViewer } = useFileViewer();

  // ── Panel state ──
  const [leftPanelOpen, setLeftPanelOpen] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [leftPanelMode, setLeftPanelMode] = useState<"list" | "tabs">("list");
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [rightPanelMode, setRightPanelMode] = useState<"list" | "tabs">("tabs");
  const [rightPanelBrowserPath, setRightPanelBrowserPath] = useState<string | null>(null);
  const [requestRightPanelView, setRequestRightPanelView] = useState<string | null>(null);

  // ── Reset panel state on view change ──
  // When navigating between views, apply user-persisted layout for the new
  // view, falling back to built-in defaults. Chat is special — per-session
  // restore handles that separately.
  const prevViewRef = useRef<View>(view);
  useEffect(() => {
    if (view === prevViewRef.current) return;
    prevViewRef.current = view;
    // Don't reset when entering chat — per-session restore handles that
    if (view === "chat") return;
    const defaults = getDefaults(view);
    const userLayout = activeUP?.layouts?.[view];
    setLeftPanelOpen(defaults.left.open);
    setLeftPanelWidth(defaults.left.width);
    setLeftPanelMode(userLayout?.left?.mode ?? defaults.left.mode);
    setRightPanelOpen(defaults.right.open);
    setRightPanelWidth(defaults.right.width);
    setRightPanelMode(userLayout?.right?.mode ?? defaults.right.mode);
    setRightPanelBrowserPath(null);
    setRequestRightPanelView(null);
  }, [view, activeUP]);

  // ── Per-session persistence ──
  const panelSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiCache = useRef<Map<string, Record<string, unknown>>>(new Map());
  const prevSessionIdRef = useRef<string | null>(null);
  const fileViewerTabsRef = useRef(fileViewerTabs);
  const fileViewerActivePathRef = useRef(fileViewerActivePath);
  const rightPanelBrowserPathRef = useRef(rightPanelBrowserPath);
  fileViewerTabsRef.current = fileViewerTabs;
  fileViewerActivePathRef.current = fileViewerActivePath;
  rightPanelBrowserPathRef.current = rightPanelBrowserPath;

  const savePanelState = useCallback((sessionId: string) => {
    if (!sessionId || sessionId.startsWith("pending-")) return;
    const scrollEl = document.querySelector(".chat-messages");
    const snapshot: Record<string, unknown> = {
      leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth,
      scrollTop: scrollEl ? scrollEl.scrollTop : 0,
      fileViewerTabs: fileViewerTabsRef.current,
      fileViewerActivePath: fileViewerActivePathRef.current,
      browserPath: rightPanelBrowserPathRef.current,
    };
    uiCache.current.set(sessionId, snapshot);
    if (uiCache.current.size > 20) {
      const oldest = uiCache.current.keys().next().value;
      if (oldest && oldest !== sessionId) uiCache.current.delete(oldest);
    }
    if (panelSaveTimer.current) clearTimeout(panelSaveTimer.current);
    panelSaveTimer.current = setTimeout(() => {
      modus.saveSessionUiState(sessionId, snapshot).catch(() => {});
    }, 300);
  }, [leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth]);

  // Save on change (debounced)
  useEffect(() => {
    const id = activeSession?.id;
    if (!id || id.startsWith("pending-") || view !== "chat") return;
    savePanelState(id);
  }, [leftPanelOpen, leftPanelWidth, rightPanelOpen, rightPanelWidth, rightPanelBrowserPath, fileViewerTabs, fileViewerActivePath, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // Restore on session switch (chat view only)
  useEffect(() => {
    if (view !== "chat") return;
    const id = activeSession?.id ?? null;

    // Only act on real (non-pending, non-null) session IDs.
    // During session creation the ID transitions through
    // real → pending → (briefly null during rekey) → new real.
    // Reacting to null/pending would needlessly reset panels and
    // clear file viewer tabs mid-creation.
    if (!id || id.startsWith("pending-")) return;

    const prevId = prevSessionIdRef.current;
    if (id === prevId) return;

    // Save outgoing session's scroll position
    if (prevId) {
      const scrollEl = document.querySelector(".chat-messages");
      if (scrollEl) {
        const cached = uiCache.current.get(prevId) ?? {};
        cached.scrollTop = scrollEl.scrollTop;
        uiCache.current.set(prevId, cached);
      }
    }

    prevSessionIdRef.current = id;

    const applyState = (state: Record<string, unknown>) => {
      setLeftPanelOpen(!!state.leftPanelOpen);
      setLeftPanelWidth(typeof state.leftPanelWidth === "number" ? state.leftPanelWidth : 280);
      setRightPanelOpen(!!state.rightPanelOpen);
      setRightPanelWidth(typeof state.rightPanelWidth === "number" ? state.rightPanelWidth : 360);
      setRightPanelBrowserPath(typeof state.browserPath === "string" ? state.browserPath : null);
      const savedTabs = Array.isArray(state.fileViewerTabs)
        ? (state.fileViewerTabs as { path: string; pinned: boolean }[]).filter(
            (t) => typeof t?.path === "string"
          )
        : [];
      const savedActivePath = typeof state.fileViewerActivePath === "string" ? state.fileViewerActivePath : null;
      hydrateFileViewer(savedTabs, savedActivePath);
      if (typeof state.scrollTop === "number" && state.scrollTop > 0) {
        requestAnimationFrame(() => {
          const scrollEl = document.querySelector(".chat-messages");
          if (scrollEl) scrollEl.scrollTop = state.scrollTop as number;
        });
      }
    };

    const cached = uiCache.current.get(id);
    if (cached) {
      applyState(cached);
    } else {
      const defaults = getDefaults("chat");
      setLeftPanelOpen(defaults.left.open);
      setLeftPanelWidth(defaults.left.width);
      setRightPanelOpen(defaults.right.open);
      setRightPanelWidth(defaults.right.width);
      modus.getSessionUiState(id).then((state) => {
        uiCache.current.set(id, state);
        if (prevSessionIdRef.current === id) applyState(state);
      }).catch(() => {});
    }
  }, [activeSession?.id, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Resolve left panel widgets ──
  // Priority: user profile per-view override → legacy leftPanel.widgets (chat only) → view defaults
  const defaults = getDefaults(view);
  const userViewLayout = activeUP?.layouts?.[view];
  const leftLayoutWidgets = userViewLayout?.left?.widgets;
  const leftWidgetConfigs = normalizePanelWidgets("left", leftLayoutWidgets);
  const legacyLeftWidgets = activeUP?.leftPanel?.widgets;
  const legacyLeftWidgetConfigs = normalizePanelWidgets("left", legacyLeftWidgets);
  const defaultLeftWidgetConfigs = normalizePanelWidgets("left", defaults.left.widgets);
  const leftPanelWidgets = leftLayoutWidgets
    ? leftWidgetConfigs
    : (view === "chat"
        ? (legacyLeftWidgets ? legacyLeftWidgetConfigs : defaultLeftWidgetConfigs)
        : defaultLeftWidgetConfigs);
  const leftPanelModeResolved = userViewLayout?.left?.mode ?? defaults.left.mode;
  const rightLayoutWidgets = userViewLayout?.right?.widgets;
  const rightWidgetConfigs = normalizePanelWidgets("right", rightLayoutWidgets);
  const defaultRightWidgetConfigs = normalizePanelWidgets("right", defaults.right.widgets);
  const rightPanelWidgets = rightLayoutWidgets ? rightWidgetConfigs : defaultRightWidgetConfigs;
  const rightPanelModeResolved = userViewLayout?.right?.mode ?? defaults.right.mode;

  useEffect(() => {
    setLeftPanelMode(leftPanelModeResolved);
    setRightPanelMode(rightPanelModeResolved);
  }, [leftPanelModeResolved, rightPanelModeResolved]);

  // ── Resolve panel trees ──
  // Priority: persisted tree → flat widgets+mode normalized into tree
  const leftPersistedTree = userViewLayout?.left?.tree;
  const rightPersistedTree = userViewLayout?.right?.tree;

  const leftPanelTree: LayoutNode = leftPersistedTree
    ? (leftPersistedTree as LayoutNode)
    : normalizePanelLayout(leftPanelModeResolved, leftPanelWidgets);

  const rightPanelTree: LayoutNode = rightPersistedTree
    ? (rightPersistedTree as LayoutNode)
    : normalizePanelLayout(rightPanelModeResolved, rightPanelWidgets);

  // Persist widget changes per-view in the user profile
  const onLeftPanelWidgetsChange = useCallback((widgets: WidgetBase[]) => {
    if (!activeUserProfile) return;
    // Chat view: also update legacy leftPanel.widgets for backwards compat
    const patch: Record<string, unknown> = {
      layouts: { [view]: { left: { widgets } } },
    };
    if (view === "chat") {
      patch.leftPanel = { widgets: widgets.map((widget) => widget.type) };
    }
    modus.patchUserProfileUiConfig(activeUserProfile, patch as any)
      .then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  const onLeftPanelModeChange = useCallback((mode: "list" | "tabs") => {
    setLeftPanelMode(mode);
    if (!activeUserProfile) return;
    modus.patchUserProfileUiConfig(activeUserProfile, {
      layouts: { [view]: { left: { mode } } },
    } as any).then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  const onRightPanelWidgetsChange = useCallback((widgets: WidgetBase[]) => {
    if (!activeUserProfile) return;
    const patch: Record<string, unknown> = {
      layouts: { [view]: { right: { widgets } } },
    };
    modus.patchUserProfileUiConfig(activeUserProfile, patch as any)
      .then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  const onLeftPanelTreeChange = useCallback((tree: LayoutNode) => {
    if (!activeUserProfile) return;
    modus.patchUserProfileUiConfig(activeUserProfile, {
      layouts: { [view]: { left: { tree } } },
    } as any).then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  const onRightPanelTreeChange = useCallback((tree: LayoutNode) => {
    if (!activeUserProfile) return;
    modus.patchUserProfileUiConfig(activeUserProfile, {
      layouts: { [view]: { right: { tree } } },
    } as any).then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  const onRightPanelModeChange = useCallback((mode: "list" | "tabs") => {
    setRightPanelMode(mode);
    if (!activeUserProfile) return;
    modus.patchUserProfileUiConfig(activeUserProfile, {
      layouts: { [view]: { right: { mode } } },
    } as any).then(() => refreshUserProfiles()).catch(() => {});
  }, [activeUserProfile, refreshUserProfiles, view]);

  // ── Panels enabled logic ──
  // Chat always has panels. Other views can opt in via VIEW_PANEL_DEFAULTS.
  // For now, only chat has panels — this is the exact toggle point to expand later.
  const panelsEnabled = !!VIEW_PANEL_DEFAULTS[view];

  // ── Clamped resize handlers ──
  const handleLeftResize = useCallback((delta: number) => {
    setLeftPanelWidth((w) => Math.max(180, Math.min(600, w + delta)));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.max(200, Math.min(800, w + delta)));
  }, []);

  const toggleLeftPanel = useCallback(() => setLeftPanelOpen((o) => !o), []);
  const toggleRightPanel = useCallback(() => setRightPanelOpen((o) => !o), []);

  return (
    <LayoutContext.Provider value={{
      leftPanelOpen,
      leftPanelWidth,
      leftPanelMode,
      leftPanelWidgets,
      setLeftPanelOpen,
      setLeftPanelWidth,
      toggleLeftPanel,
      onLeftPanelWidgetsChange,
      onLeftPanelModeChange,

      rightPanelOpen,
      rightPanelWidth,
      rightPanelMode,
      rightPanelWidgets,
      rightPanelBrowserPath,
      requestRightPanelView,
      setRightPanelOpen,
      setRightPanelWidth,
      toggleRightPanel,
      setRightPanelBrowserPath,
      setRequestRightPanelView,
      onRightPanelWidgetsChange,
      onRightPanelModeChange,

      handleLeftResize,
      handleRightResize,

      leftPanelTree,
      rightPanelTree,
      onLeftPanelTreeChange,
      onRightPanelTreeChange,

      currentView: view,
      panelsEnabled,
    }}>
      {children}
    </LayoutContext.Provider>
  );
}
