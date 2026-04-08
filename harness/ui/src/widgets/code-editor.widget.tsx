import type { WidgetProps } from "./types";
import { CodeWorkspacePanel } from "../components/CodeWorkspacePanel";
import { useRightPanelContext } from "../components/RightPanelContext";

export default function CodeEditorWidget({ active = true }: WidgetProps) {
  const { browserPath, setBrowserPath } = useRightPanelContext();
  return (
    <CodeWorkspacePanel
      active={active}
      initialBrowserPath={browserPath}
      onBrowserPathChange={setBrowserPath}
    />
  );
}
