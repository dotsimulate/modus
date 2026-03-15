/**
 * NotesPage — full-page notes view with speech-to-text.
 *
 * Full-screen note editor with list sidebar and always-visible
 * speech-to-text controls.
 */

import { useProfiles } from "../providers/ProfileProvider";
import { NotesEditor } from "./NotesEditor";

export function NotesPage() {
  const { activeCwd } = useProfiles();

  return (
    <div className="notes-page">
      <div className="notes-page-inner">
        <div className="notes-page-header">
          <span className="notes-page-title">notes</span>
          {activeCwd && (
            <span className="notes-page-path">{activeCwd}</span>
          )}
        </div>
        <div className="notes-page-body">
          <NotesEditor cwd={activeCwd ?? null} />
        </div>
      </div>
    </div>
  );
}
