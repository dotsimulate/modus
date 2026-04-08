import { createContext, useContext } from "react";
import type { View } from "../views";
import type { LayoutNode, WidgetBase } from "../widgets";

type LayoutContextValue = {
  // Left panel
  leftPanelOpen: boolean;
  leftPanelWidth: number;
  leftPanelMode: "list" | "tabs";
  leftPanelWidgets: WidgetBase[];
  setLeftPanelOpen: (open: boolean) => void;
  setLeftPanelWidth: (width: number) => void;
  toggleLeftPanel: () => void;
  onLeftPanelWidgetsChange: (widgets: WidgetBase[]) => void;
  onLeftPanelModeChange: (mode: "list" | "tabs") => void;

  // Right panel
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelMode: "list" | "tabs";
  rightPanelWidgets: WidgetBase[];
  rightPanelBrowserPath: string | null;
  requestRightPanelView: string | null;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelBrowserPath: (path: string | null) => void;
  setRequestRightPanelView: (view: string | null) => void;
  onRightPanelWidgetsChange: (widgets: WidgetBase[]) => void;
  onRightPanelModeChange: (mode: "list" | "tabs") => void;

  // Resize handlers (clamped)
  handleLeftResize: (delta: number) => void;
  handleRightResize: (delta: number) => void;

  // Panel trees (resolved from persisted tree or flat widgets+mode)
  leftPanelTree: LayoutNode;
  rightPanelTree: LayoutNode;
  onLeftPanelTreeChange: (tree: LayoutNode) => void;
  onRightPanelTreeChange: (tree: LayoutNode) => void;

  // Current view awareness
  currentView: View;

  // Whether panels should show for the current view
  panelsEnabled: boolean;
};

export const LayoutContext = createContext<LayoutContextValue>(null!);
export const useLayout = () => useContext(LayoutContext);
