/**
 * ModusPrompt — general-purpose modus-dev editor prompt.
 *
 * Lives at the top of the dashboard. User types what they want to configure,
 * modus-dev runs, user can watch the session inline via MiniSession.
 * Recent modus-dev sessions listed below the input.
 */

import { useState, useCallback, useEffect } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { createSession, fetchSessionsByProfile } from "../api";
import { useSessionState } from "../sessionStore";
import { MiniSession } from "./MiniSession";
import type { SessionInfo } from "../api";

type Props = {
  onSelectSession: (id: string) => void;
};

type Phase = "idle" | "running" | "done" | "error";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ModusPrompt({ onSelectSession }: Props) {
  const { activeUP, activeUserProfile, refreshProfiles, refreshUserProfiles } = useProfiles();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);

  // Watch the active session via sessionStore (SSE-driven, no polling)
  const activeSession = useSessionState(phase === "running" ? sessionId : null);

  // Detect when the running session finishes
  useEffect(() => {
    if (phase !== "running" || !activeSession) return;
    if (activeSession.status === "idle") {
      Promise.all([refreshProfiles(), refreshUserProfiles()]).catch(() => {});
      fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined).then(setRecentSessions).catch(() => {});
      setPhase("done");
      setPrompt("");
    } else if (activeSession.status === "error") {
      setError("agent error");
      setPhase("error");
    }
  }, [phase, activeSession?.status]);

  // Fetch recent modus-dev sessions (scoped to active user profile)
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const sessions = await fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined);
        if (active) setRecentSessions(sessions);
      } catch { /* silent */ }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => { active = false; clearInterval(interval); };
  }, [activeUserProfile]);

  // Auto-dismiss done state
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => setPhase("idle"), 3000);
    return () => clearTimeout(t);
  }, [phase]);

  const run = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;

    const slug = activeUserProfile ?? "";
    const userDisplay = activeUP?.displayName ?? slug;
    const paths = activeUP?.projects ?? [];

    const structuredPrompt = [
      `## Edit Request`,
      ``,
      `Modify MO configuration based on the user's description.`,
      ``,
      `### User`,
      `- Name: ${userDisplay}`,
      ...(slug ? [`- Profile slug: ${slug}`] : []),
      ...(paths.length > 0 ? [`- Project paths: ${paths.join(", ")}`] : []),
      ``,
      `### What they want`,
      text,
      ``,
      `### Tasks`,
      `1. Read the relevant skill (create-profile or create-action) for schemas`,
      `2. Make the requested changes — create/edit profiles, actions, etc.`,
      ...(slug ? [`3. If creating new agent profiles, add them to profiles/users/${slug}.json agentProfiles array`] : []),
      `4. List what you created or changed`,
      ``,
      `### Rules`,
      `- Use Edit on existing files, Write only for new ones`,
      `- Use permissionPolicy: "bypass" unless restrictions are requested`,
      `- Omit optional fields that use defaults — keep JSON clean`,
      `- Agent prompts: 2-6 sentences, dense and directive`,
    ].join("\n");

    setPhase("running");
    setError("");
    setSessionId(null);

    try {
      const { sessionId: sid } = await createSession({
        prompt: structuredPrompt,
        profile: "modus-dev",
        userProfile: activeUserProfile ?? undefined,
      });
      setSessionId(sid);
    } catch (err) {
      setError(`failed to start: ${err}`);
      setPhase("error");
    }
  }, [prompt, activeUserProfile, activeUP, refreshProfiles, refreshUserProfiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && prompt.trim()) {
      e.preventDefault();
      run();
    }
  };

  return (
    <div className="modus-prompt">
      <div className="modus-prompt-label">configure</div>
      <p className="modus-prompt-hint">
        create agents, edit profiles, set up actions, or change any MO configuration
      </p>

      {/* ── Running: inline MiniSession ── */}
      {phase === "running" && sessionId && (
        <div className="modus-prompt-running">
          <MiniSession sessionId={sessionId} onNavigate={onSelectSession} />
          <button
            className="modus-prompt-cancel"
            onClick={() => setPhase("idle")}
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── Done state ── */}
      {phase === "done" && (
        <div className="modus-prompt-done">
          <span className="modus-prompt-done-text">done — configuration updated</span>
          {sessionId && (
            <button
              className="modus-prompt-link"
              onClick={() => onSelectSession(sessionId)}
            >
              view session
            </button>
          )}
        </div>
      )}

      {/* ── Error state ── */}
      {phase === "error" && (
        <div className="modus-prompt-error-row">
          <span className="modus-prompt-error">{error}</span>
          {sessionId && (
            <button
              className="modus-prompt-link"
              onClick={() => onSelectSession(sessionId)}
            >
              view session
            </button>
          )}
          <button
            className="modus-prompt-cancel"
            onClick={() => setPhase("idle")}
          >
            dismiss
          </button>
        </div>
      )}

      {/* ── Input ── */}
      {(phase === "idle" || phase === "done") && (
        <div className="modus-prompt-input-row">
          <textarea
            className="modus-prompt-textarea"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="describe what you want to set up or change..."
            rows={2}
            spellCheck={false}
          />
          <div className="modus-prompt-actions">
            <button
              className="modus-prompt-run"
              onClick={run}
              disabled={!prompt.trim()}
            >
              run
            </button>
          </div>
        </div>
      )}

      {/* ── Recent modus-dev sessions ── */}
      {recentSessions.length > 0 && (
        <div className="modus-prompt-recent">
          <div className="modus-prompt-recent-label">recent</div>
          {recentSessions.map((s) => (
            <button
              key={s.id}
              className="modus-prompt-session"
              onClick={() => onSelectSession(s.id)}
            >
              <span className={`modus-prompt-session-dot ${s.status === "running" ? "modus-prompt-session-dot--active" : ""}`} />
              <span className="modus-prompt-session-text">
                {s.last_prompt || s.preview || "modus-dev session"}
              </span>
              <span className="modus-prompt-session-time">{timeAgo(s.last_message_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
