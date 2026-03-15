/**
 * Notes widget — compact note-taking for sidebar panels.
 *
 * Config example:
 *   { "id": "notes-left", "type": "notes", "title": "notes" }
 */

import { useProfiles } from "../providers/ProfileProvider";
import { NotesEditor } from "../components/NotesEditor";
import type { WidgetDef } from "./index";

function NotesWidget() {
  const { activeCwd } = useProfiles();

  return (
    <div className="notes-widget-wrap">
      <NotesEditor cwd={activeCwd ?? null} compact />
    </div>
  );
}

const def: WidgetDef = { type: "notes", component: NotesWidget };
export default def;
