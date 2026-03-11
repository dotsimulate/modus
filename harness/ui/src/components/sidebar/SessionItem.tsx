import { useState, useRef, useEffect } from "react";
import type { SessionInfo } from "../../api";
import { updateSessionTitle } from "../../api";
import { useSessionState } from "../../sessionStore";
import { formatSidebarProviderStat, getLatestAssistantUsage } from "../providerStats";

type Props = {
  session: SessionInfo;
  active: boolean;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
};

function statusDotClass(status: string): string {
  if (status === "running") return "dash-dot--streaming";
  if (status === "starting" || status === "idle") return "dash-dot--running";
  if (status === "error") return "dash-dot--error";
  return "dash-dot--done";
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function displayText(s: SessionInfo): string {
  return s.title ?? s.last_prompt ?? s.preview;
}

export function SessionItem({ session: s, active, onSelect, onArchive }: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const liveSession = useSessionState(s.id);
  const latestUsage = liveSession ? getLatestAssistantUsage(liveSession.messages) : null;
  const provider = liveSession?.agentConfig.provider ?? s.provider;
  const costUsd = provider === "claude-code"
    ? s.total_cost_usd
    : (latestUsage?.cost ?? s.total_cost_usd);
  const usageText = formatSidebarProviderStat(provider, {
    model: liveSession?.model ?? s.model,
    costUsd,
    inputTokens: latestUsage?.inputTokens ?? s.last_input_tokens,
    outputTokens: latestUsage?.outputTokens ?? s.last_output_tokens,
  });

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = () => {
    setEditValue(s.title ?? "");
    setEditing(true);
  };

  const commitEdit = async () => {
    setEditing(false);
    const trimmed = editValue.trim();
    const newTitle = trimmed || null;
    if (newTitle === (s.title ?? null)) return;
    s.title = newTitle; // optimistic
    await updateSessionTitle(s.id, newTitle);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  return (
    <div
      className={`session-item ${active ? "active" : ""}`}
      onClick={() => !editing && onSelect(s.id)}
    >
      <div className="session-item-preview">
        <span className={`dash-dot ${statusDotClass(s.status)}`} />
        {editing ? (
          <input
            ref={inputRef}
            className="session-title-input"
            value={editValue}
            placeholder={s.last_prompt ?? s.preview}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") cancelEdit();
            }}
            onBlur={commitEdit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="session-item-text"
            onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
          >
            {displayText(s)}
          </span>
        )}
      </div>
      <div className="session-item-meta">
        <span className="session-meta-left">
          <span className="session-profile-tag">
            {provider ?? "unknown"}
          </span>
          <span>{s.message_count} msg</span>
          {usageText && <span>{usageText}</span>}
        </span>
        <span className="session-meta-right">
          <span>{timeAgo(s.updated_at)}</span>
          <button
            className="session-archive-btn"
            onClick={(e) => { e.stopPropagation(); onArchive(s.id); }}
            title="Archive session"
          >
            &times;
          </button>
        </span>
      </div>
    </div>
  );
}
