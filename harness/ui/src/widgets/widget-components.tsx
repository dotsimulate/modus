import type { ReactNode } from "react";
import { ActivityChart } from "../components/ActivityChart";
import { HBar } from "../components/HBar";
import { CustomSelect } from "../components/CustomSelect";
import { Markdown } from "../components/Markdown";

/**
 * Small component barrel for widget authors.
 *
 * This is not a hard boundary. Widgets can still import any UI component.
 * It exists to surface the common, low-risk primitives first.
 */
export {
  ActivityChart,
  HBar,
  CustomSelect,
  Markdown,
};

export function WidgetEmptyState({ children }: { children: ReactNode }) {
  return <div className="dash-empty">{children}</div>;
}
