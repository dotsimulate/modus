/**
 * ModusPrompt — simple two-tab prompt box on dashboard.
 *
 * Tabs: "create agent" / "configure modus"
 * Each tab: prompt picker (downward) + textarea + run button.
 * Recent modus-dev sessions listed below.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { createSession, fetchSessionsByProfile, renderPromptApi } from "../api";
import { useSessionState } from "../sessionStore";
import { PromptPicker } from "./PromptPicker";
import { MiniSession } from "./MiniSession";
import { PromptComposer } from "./PromptComposer";
import type { SessionInfo } from "../api";
import type { PromptSettings } from "./PromptPicker";

type Props = {
  onSelectSession: (id: string) => void;
  isNewProject?: boolean;
};

type Phase = "idle" | "running" | "done" | "error";
type Tab = "create" | "configure";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ModusPrompt({ onSelectSession, isNewProject }: Props) {
  const { activeUP, activeUserProfile, refreshProfiles, refreshUserProfiles } = useProfiles();
  const [tab, setTab] = useState<Tab>(isNewProject ? "create" : "configure");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const projectCwd = activeUP?.projects?.[0];

  const activeSession = useSessionState(phase === "running" ? sessionId : null);

  // Detect when running session finishes
  useEffect(() => {
    if (phase !== "running" || !activeSession) return;
    if (activeSession.status === "idle") {
      Promise.all([refreshProfiles(), refreshUserProfiles()]).catch(() => {});
      fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined)
        .then(setRecentSessions).catch(() => {});
      setPhase("done");
      setPrompt("");
    } else if (activeSession.status === "error") {
      setError("agent error");
      setPhase("error");
    }
  }, [phase, activeSession?.status]);

  // Fetch recent modus-dev sessions
  useEffect(() => {
    let active = true;
    fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined)
      .then(s => { if (active) setRecentSessions(s); }).catch(() => {});
    const interval = setInterval(() => {
      fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined)
        .then(s => { if (active) setRecentSessions(s); }).catch(() => {});
    }, 10000);
    return () => { active = false; clearInterval(interval); };
  }, [activeUserProfile]);

  // Auto-dismiss done state
  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(() => setPhase("idle"), 3000);
    return () => clearTimeout(t);
  }, [phase]);

  // Focus textarea on tab switch
  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [tab]);

  const run = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;

    const paths = activeUP?.projects ?? [];
    const cwd = paths[0] || undefined;
    const project = {
      name: activeUP?.displayName || activeUserProfile || "project",
      slug: activeUserProfile,
      paths,
    };

    setPhase("running");
    setError("");
    setSessionId(null);

    try {
      // Render the appropriate prompt template to inject context
      let renderedPrompt = text;
      try {
        const promptName = tab === "create" ? "setup-agents" : "configure";
        const vars = tab === "create"
          ? { inputs: { text, description: text, archetype: "custom" }, project, projectCwd: cwd }
          : { inputs: { text, mode: "edit", agents: "yes" }, project, projectCwd: cwd };
        const result = await renderPromptApi(promptName, vars);
        renderedPrompt = result.rendered;
      } catch {
        // fall back to raw text if render fails
      }

      const { sessionId: sid } = await createSession({
        prompt: renderedPrompt,
        profile: "modus-dev",
        userProfile: activeUserProfile ?? undefined,
        cwd,
      });
      setSessionId(sid);
    } catch (err) {
      setError(`failed to start: ${err}`);
      setPhase("error");
    }
  }, [prompt, activeUserProfile, activeUP, tab]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && prompt.trim()) {
      e.preventDefault();
      run();
    }
  };

  const handleInject = useCallback((text: string, _settings?: PromptSettings) => {
    const existing = prompt;
    if (!existing.trim()) {
      setPrompt(text);
    } else {
      setPrompt(existing + "\n" + text);
    }
    textareaRef.current?.focus();
  }, [prompt]);

  const handleMoveActivated = useCallback((result: { spawnedSessionId?: string }) => {
    if (result.spawnedSessionId) {
      onSelectSession(result.spawnedSessionId);
    }
  }, [onSelectSession]);

  return (
    <div className="modus-prompt">
      {/* ── Tabs ── */}
      <div className="modus-prompt-tabs">
        <button
          className={`modus-prompt-tab ${tab === "create" ? "modus-prompt-tab--active" : ""}`}
          onClick={() => setTab("create")}
        >
          create agent
        </button>
        <button
          className={`modus-prompt-tab ${tab === "configure" ? "modus-prompt-tab--active" : ""}`}
          onClick={() => setTab("configure")}
        >
          configure modus
        </button>
      </div>

      {/* ── Running: starting or inline MiniSession ── */}
      {phase === "running" && !sessionId && (
        <div className="modus-prompt-running">
          <div className="mini-session">
            <div className="mini-session-status">
              <span className="mini-session-dot mini-session-dot--starting" />
              <span>starting...</span>
            </div>
          </div>
          <button className="modus-prompt-cancel" onClick={() => setPhase("idle")}>
            dismiss
          </button>
        </div>
      )}
      {phase === "running" && sessionId && (
        <div className="modus-prompt-running">
          <MiniSession sessionId={sessionId} onNavigate={onSelectSession} />
          <button className="modus-prompt-cancel" onClick={() => setPhase("idle")}>
            dismiss
          </button>
        </div>
      )}

      {/* ── Done state ── */}
      {phase === "done" && (
        <div className="modus-prompt-done">
          <span className="modus-prompt-done-text">done</span>
          {sessionId && (
            <button className="modus-prompt-link" onClick={() => onSelectSession(sessionId)}>
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
            <button className="modus-prompt-link" onClick={() => onSelectSession(sessionId)}>
              view session
            </button>
          )}
          <button className="modus-prompt-cancel" onClick={() => setPhase("idle")}>
            dismiss
          </button>
        </div>
      )}

      {/* ── Input area ── */}
      {(phase === "idle" || phase === "done") && (
        <div className="modus-prompt-input-row">
          <div className="modus-prompt-textarea-wrap">
            <PromptComposer
              textareaRef={textareaRef}
              value={prompt}
              onChange={setPrompt}
              onKeyDown={handleKeyDown}
              onSubmit={run}
              submitDisabled={!prompt.trim()}
              placeholder={tab === "create"
                ? "describe the agent you want to create..."
                : "describe what you want to configure..."
              }
              rows={4}
              leftSlot={
                <PromptPicker
                  onInject={handleInject}
                  direction="down"
                  tags={tab === "create" ? ["dashboard", "create"] : ["dashboard", "configure"]}
                  projectCwd={projectCwd}
                  userProfile={activeUserProfile ?? undefined}
                  onMoveActivated={handleMoveActivated}
                />
              }
            />
          </div>
        </div>
      )}

      {/* ── Recent sessions ── */}
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
