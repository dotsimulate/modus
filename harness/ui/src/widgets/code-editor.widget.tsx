import { useState, useCallback } from "react";
import type { WidgetProps } from "./types";
import { CodeWorkspacePanel } from "../components/CodeWorkspacePanel";
import { useOptionalRightPanelContext } from "../components/RightPanelContext";

export default function CodeEditorWidget({ active = true, onSelectSession, pageContext }: WidgetProps) {
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

  // On a page, publish the selection to the scope so the page decides what to do
  // with it; elsewhere fall back to the host's navigation callback.
  const handleSelectSession = useCallback((id: string) => {
    if (pageContext) {
      pageContext.emit({ type: "select-session", sessionId: id });
    } else {
      onSelectSession(id);
    }
  }, [pageContext, onSelectSession]);

  return (
    <CodeWorkspacePanel
      active={active}
      initialBrowserPath={browserPath}
      onBrowserPathChange={setBrowserPath}
      onSelectSession={handleSelectSession}
    />
  );
}
