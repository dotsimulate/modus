/**
 * File Browser widget — compact folder/file navigation for sidebar panels.
 *
 * Config example:
 *   { "id": "files-left", "type": "file-browser", "title": "files" }
 *
 * Clicking a file opens it in the RightPanel viewer via FileViewerProvider.
 */

import { useProfiles } from "../providers/ProfileProvider";
import { useFileViewer } from "../providers/FileViewerProvider";
import { FileBrowser } from "../components/FileBrowser";
import type { WidgetDef } from "./index";

function FileBrowserWidget() {
  const { activeCwd } = useProfiles();
  const { openFile } = useFileViewer();

  return (
    <div className="fb-widget-wrap">
      <FileBrowser
        rootPath={activeCwd ?? null}
        compact
        onFileSelect={openFile}
      />
    </div>
  );
}

const def: WidgetDef = { type: "file-browser", component: FileBrowserWidget };
export default def;
