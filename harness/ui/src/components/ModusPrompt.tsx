/**
 * ModusPrompt — general-purpose modus-dev editor prompt.
 *
 * Lives at the top of the dashboard. User types what they want to configure,
 * modus-dev runs, user can watch the session via a link. When done, profiles refresh.
 * Recent modus-dev sessions listed below the input.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { createSession, fetchSessions, fetchSessionStatus, fetchSessionsByProfile } from "../api";
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
  const [statusText, setStatusText] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const pollRef = useRef(false);

  // Fetch recent modus-dev sessions
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const sessions = await fetchSessionsByProfile("modus-dev", 5);
        if (active) setRecentSessions(sessions);
      } catch { /* silent */ }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  // Re-fetch after completion
  useEffect(() => {
    if (phase !== "done") return;
    fetchSessionsByProfile("modus-dev", 5).then(setRecentSessions).catch(() => {});
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
    setStatusText("starting...");
    setError("");
    setSessionId(null);
    pollRef.current = true;

    try {
      const { sessionId: initialId } = await createSession({
        prompt: structuredPrompt,
        profile: "modus-dev",
      });

      // Resolve real session ID (backend rekeys ses-* to UUIDs)
      let sid = initialId;
      if (sid.startsWith("ses-")) {
        for (let i = 0; i < 30 && pollRef.current; i++) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            const sessions = await fetchSessions(1);
            if (sessions.length > 0 && !sessions[0].id.startsWith("ses-")) {
              sid = sessions[0].id;
              break;
            }
          } catch { /* keep trying */ }
        }
      }

      setSessionId(sid);

      // Poll until done
      for (let i = 0; i < 120 && pollRef.current; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const status = await fetchSessionStatus(sid);
          if (status.status === "idle") {
            setStatusText("done");
            await Promise.all([refreshProfiles(), refreshUserProfiles()]);
            setPhase("done");
            setPrompt("");
            return;
          }
          if (status.status === "error") {
            setError(status.error || "agent error");
            setPhase("error");
            return;
          }
          const turns = status.numTurns ?? 0;
          setStatusText(turns > 0 ? `working... (${turns} turn${turns !== 1 ? "s" : ""})` : "working...");
        } catch { /* keep polling */ }
      }
      if (pollRef.current) {
        setError("timed out");
        setPhase("error");
      }
    } catch (err) {
      setError(`failed to start: ${err}`);
      setPhase("error");
    }
  }, [prompt, activeUserProfile, activeUP, refreshProfiles, refreshUserProfiles]);

  // Cleanup on unmount
  useEffect(() => () => { pollRef.current = false; }, []);

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

      {/* ── Running state ── */}
      {phase === "running" && (
        <div className="modus-prompt-running">
          <div className="modus-prompt-status">
            <span className="modus-prompt-dot" />
            <span>{statusText}</span>
            {sessionId && (
              <button
                className="modus-prompt-link"
                onClick={() => onSelectSession(sessionId)}
              >
                watch session
              </button>
            )}
            <button
              className="modus-prompt-cancel"
              onClick={() => { pollRef.current = false; setPhase("idle"); }}
            >
              cancel
            </button>
          </div>
          <div className="modus-prompt-progress">
            <div className="modus-prompt-progress-fill" />
          </div>
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
