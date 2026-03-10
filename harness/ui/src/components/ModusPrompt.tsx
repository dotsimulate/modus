/**
 * ModusPrompt — unified prompt component for dashboard.
 *
 * Shows available prompt templates as selectable presets. User picks one,
 * fills in inputs + free text, submit renders the template and creates
 * a modus-dev session. Replaces both the old ModusPrompt and ProjectSetup's
 * agent phase.
 *
 * Recent modus-dev sessions listed below the input.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { useProfiles } from "../providers/ProfileProvider";
import { createSession, fetchSessionsByProfile, fetchPrompts, renderPromptApi } from "../api";
import { useSessionState } from "../sessionStore";
import { MiniSession } from "./MiniSession";
import type { SessionInfo, PromptListItem } from "../api";

type Props = {
  onSelectSession: (id: string) => void;
  /** Hint that this is a fresh project — bias toward setup prompts */
  isNewProject?: boolean;
};

type Phase = "idle" | "running" | "done" | "error";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ModusPrompt({ onSelectSession, isNewProject }: Props) {
  const { activeUP, activeUserProfile, refreshProfiles, refreshUserProfiles } = useProfiles();
  const [prompts, setPrompts] = useState<PromptListItem[]>([]);
  const [selectedPrompt, setSelectedPrompt] = useState<string | null>(null);
  const [inputValues, setInputValues] = useState<Record<string, string>>({});
  const [freeText, setFreeText] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeSession = useSessionState(phase === "running" ? sessionId : null);
  const selected = prompts.find(p => p.name === selectedPrompt) ?? null;

  // Load available prompts
  useEffect(() => {
    let active = true;
    fetchPrompts({ tags: ["dashboard"] }).then(list => {
      if (!active) return;
      setPrompts(list);
      // Auto-select: if new project, prefer setup-agents or explore; otherwise first
      if (list.length > 0 && !selectedPrompt) {
        if (isNewProject) {
          const setup = list.find(p => p.name === "setup-agents");
          setSelectedPrompt(setup?.name ?? list[0]!.name);
        } else {
          setSelectedPrompt(list[0]!.name);
        }
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Detect when running session finishes
  useEffect(() => {
    if (phase !== "running" || !activeSession) return;
    if (activeSession.status === "idle") {
      Promise.all([refreshProfiles(), refreshUserProfiles()]).catch(() => {});
      fetchSessionsByProfile("modus-dev", 5, activeUserProfile ?? undefined)
        .then(setRecentSessions).catch(() => {});
      setPhase("done");
      setFreeText("");
      setInputValues({});
    } else if (activeSession.status === "error") {
      setError("agent error");
      setPhase("error");
    }
  }, [phase, activeSession?.status]);

  // Fetch recent modus-dev sessions
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

  // When prompt selection changes, reset inputs and focus textarea
  useEffect(() => {
    setInputValues({});
    setFreeText("");
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [selectedPrompt]);

  const canSubmit = useCallback(() => {
    if (!selected) return false;
    // Check required inputs
    for (const inp of selected.inputs ?? []) {
      if (inp.required && !inputValues[inp.name]?.trim()) return false;
    }
    // Need at least some text somewhere (free text or a filled input)
    const hasInput = freeText.trim() || Object.values(inputValues).some(v => v.trim());
    return hasInput;
  }, [selected, inputValues, freeText]);

  const run = useCallback(async () => {
    if (!selected || !canSubmit()) return;

    const slug = activeUserProfile ?? "";
    const paths = activeUP?.projects ?? [];

    // Build render variables
    const vars: Record<string, unknown> = {
      input: freeText.trim() || undefined,
      project: {
        name: activeUP?.displayName || slug || "project",
        slug,
        paths,
      },
      ...inputValues,
    };

    setPhase("running");
    setError("");
    setSessionId(null);

    try {
      // Render the prompt template
      const { rendered, config } = await renderPromptApi(selected.name, vars);

      // Create session with rendered prompt
      const profile = config.profile ?? selected.profile ?? "modus-dev";
      const { sessionId: sid } = await createSession({
        prompt: rendered,
        profile,
        userProfile: activeUserProfile ?? undefined,
        cwd: paths[0] || undefined,
        ...(config.settings?.provider ? { provider: config.settings.provider } : {}),
        ...(config.settings?.model ? { model: config.settings.model } : {}),
        ...(config.settings?.effort ? { effort: config.settings.effort } : {}),
      });
      setSessionId(sid);
    } catch (err) {
      setError(`failed to start: ${err}`);
      setPhase("error");
    }
  }, [selected, freeText, inputValues, activeUserProfile, activeUP, canSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && canSubmit()) {
      e.preventDefault();
      run();
    }
  };

  const setInput = (name: string, value: string) => {
    setInputValues(prev => ({ ...prev, [name]: value }));
  };

  return (
    <div className="modus-prompt">
      {/* ── Prompt selector ── */}
      {prompts.length > 1 && (
        <div className="modus-prompt-selector">
          {prompts.map(p => (
            <button
              key={p.name}
              className={`modus-prompt-preset ${selectedPrompt === p.name ? "modus-prompt-preset--active" : ""}`}
              onClick={() => setSelectedPrompt(p.name)}
              title={p.description}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Label + hint ── */}
      {selected && (
        <>
          {prompts.length <= 1 && (
            <div className="modus-prompt-label">{selected.label}</div>
          )}
          {selected.description && (
            <p className="modus-prompt-hint">{selected.description}</p>
          )}
        </>
      )}

      {/* ── Running: inline MiniSession ── */}
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
      {(phase === "idle" || phase === "done") && selected && (
        <div className="modus-prompt-input-row">
          {/* Named inputs from prompt config */}
          {(selected.inputs ?? []).map(inp => (
            <input
              key={inp.name}
              className="modus-prompt-field"
              value={inputValues[inp.name] ?? ""}
              onChange={(e) => setInput(inp.name, e.target.value)}
              placeholder={inp.placeholder ?? inp.name}
              spellCheck={false}
            />
          ))}

          {/* Free text textarea */}
          <textarea
            ref={textareaRef}
            className="modus-prompt-textarea"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="additional context..."
            rows={2}
            spellCheck={false}
          />
          <div className="modus-prompt-actions">
            <button
              className="modus-prompt-run"
              onClick={run}
              disabled={!canSubmit()}
            >
              run
            </button>
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
