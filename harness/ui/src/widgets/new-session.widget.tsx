/**
 * New Session widget — profile picker + new chat button.
 *
 * Config: { "type": "new-session" }
 *
 * Designed for page layouts like Chat Studio. Shows a centered profile
 * picker when no session is selected. Clicking a profile creates a new
 * session with that profile and publishes it to the page context bus.
 *
 * Use with showWhen/hideWhen to control visibility:
 *   "showWhen": { "activeSessionId": null }
 */

import { useCallback, useState } from "react";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import type { WidgetBase, WidgetProps } from "./types";

type NewSessionConfig = WidgetBase & {
  type: "new-session";
};

export default function NewSessionWidget({ pageContext, onSelectSession }: WidgetProps<NewSessionConfig>) {
  const { visibleProfiles, selectProfile } = useProfiles();
  const { newSession } = useSession();
  const [busy, setBusy] = useState(false);

  const handleNewSession = useCallback(async (profileName?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (profileName) selectProfile(profileName);
      const id = await newSession();
      if (id) {
        pageContext?.set("selectedSession", id);
        onSelectSession(id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, newSession, selectProfile, pageContext, onSelectSession]);

  return (
    <div className="new-session-widget">
      <div className="nsw-inner">
        <div className="nsw-heading">new chat</div>
        <div className="nsw-profiles">
          {visibleProfiles.map((p) => (
            <button
              key={p.name}
              className="nsw-profile"
              onClick={() => handleNewSession(p.name)}
              disabled={busy}
            >
              <span className="nsw-profile-name">{p.name}</span>
              {p.model && <span className="nsw-profile-model">{shortModel(p.model)}</span>}
              {p.provider && <span className="nsw-profile-provider">{p.provider}</span>}
            </button>
          ))}
        </div>
        {visibleProfiles.length === 0 && (
          <button
            className="nsw-profile nsw-profile--default"
            onClick={() => handleNewSession()}
            disabled={busy}
          >
            <span className="nsw-profile-name">start chat</span>
          </button>
        )}
      </div>
    </div>
  );
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/^gpt-/, "");
}
