import type { WidgetBase, LayoutLeaf, LayoutNode } from "./types";

export function normalizePanelLayout(
  mode: "list" | "tabs",
  widgets: WidgetBase[],
): LayoutNode {
  const children: LayoutLeaf[] = widgets.map((widget, index) => ({
    kind: "widget",
    id: widget.id ?? `leaf-${index}`,
    widget,
  }));

  return {
    kind: mode,
    id: "root",
    children,
  };
}
