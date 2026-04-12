import { useState, useCallback } from "react";
import type { WidgetProps } from "./types";
import { CodeWorkspacePanel } from "../components/CodeWorkspacePanel";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";

export default function CodeEditorWidget({ active = true }: WidgetProps) {
  const panel = useOptionalRightPanelContext();

  // When inside RightPanel, use its browser path state.
  // When on a page layout (no panel context), use local state.
  const [localPath, setLocalPath] = useState<string | null>(null);

  const browserPath = panel?.browserPath ?? localPath;
  const setBrowserPath = useCallback(
    (path: string | null) => {
      if (panel) {
        panel.setBrowserPath(path);
      } else {
        setLocalPath(path);
      }
    },
    [panel],
  );

  return (
    <CodeWorkspacePanel
      active={active}
      initialBrowserPath={browserPath}
      onBrowserPathChange={setBrowserPath}
    />
  );
}
