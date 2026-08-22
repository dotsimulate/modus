import { memo, useState, useRef, useEffect } from "react";
import type { SessionInfo } from "../../../../sdk/index";
import { modus } from "../../modusClient";
import { useSessionState } from "../../sessionStore";
import { sessionActivityAt as activityAt } from "../../sessionActivity";
import { formatSidebarProviderStat, getLatestAssistantUsage } from "../providerStats";
import { compactModelName, isEmptySession, sessionDisplayText, timeAgo } from "../../utils/format";

type Props = {
  session: SessionInfo;
  active: boolean;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  draftInput?: string;
  tags?: string[];
  onTogglePin?: () => void;
};

function statusDotClass(status: string): string {
  if (status === "running") return "dash-dot--streaming";
  if (status === "starting" || status === "idle") return "dash-dot--running";
  if (status === "error") return "dash-dot--error";
  return "dash-dot--done";
}

const displayText = sessionDisplayText;

export const SessionItem = memo(function SessionItem({ session: s, active, onSelect, onArchive, draftInput, tags, onTogglePin }: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const liveSession = useSessionState(s.id);
  const latestUsage = liveSession ? getLatestAssistantUsage(liveSession.messages) : null;
  const provider = liveSession?.agentConfig.provider ?? s.provider;
  const model = liveSession?.model ?? s.model;
  const costUsd = provider === "claude-code"
    ? s.total_cost_usd
    : (latestUsage?.cost ?? s.total_cost_usd);
  const usageText = formatSidebarProviderStat(provider, {
    model,
    costUsd,
    inputTokens: latestUsage?.inputTokens ?? s.last_input_tokens,
    outputTokens: latestUsage?.outputTokens ?? s.last_output_tokens,
  });
  const compactUsageText = usageText?.replace(/\stok$/, "t");

  const isPinned = (tags ?? []).includes("pinned");
  const agentProfile = liveSession?.profile ?? s.profile;
  const compactModel = model ? compactModelName(model) : null;
  const pendingPermissionCount = liveSession?.pendingPermissions?.length ?? s.pending_permission_count ?? 0;
  const status = liveSession?.status ?? s.status;

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
    await modus.updateTitle(s.id, newTitle);
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
        <span className={`dash-dot ${isEmptySession(s) && draftInput?.trim() ? "dash-dot--draft" : statusDotClass(status)}`} />
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
            className={`session-item-text${isEmptySession(s) ? " session-item-text--empty" : ""}`}
            onDoubleClick={(e) => { e.stopPropagation(); startEdit(); }}
          >
            {isEmptySession(s)
              ? (draftInput?.trim() || "new session")
              : displayText(s)}
          </span>
        )}
      </div>
      <div className={`session-item-meta${isEmptySession(s) ? " session-item-meta--empty" : ""}`}>
        <div className="session-meta-row">
          <span className="session-meta-left">
            {agentProfile && <span className="session-profile-tag">{agentProfile}</span>}
            {compactModel && <span className="session-model-tag">{compactModel}</span>}
            {pendingPermissionCount > 0 && (
              <span className="session-permission-tag" title="Waiting for tool approval">approval</span>
            )}
          </span>
        </div>
        <div className="session-meta-row">
          <span className="session-meta-left">
            <span>{s.message_count}m</span>
            {compactUsageText && <span>{compactUsageText}</span>}
          </span>
          <span className="session-meta-right">
            <span>{timeAgo(activityAt(s))}</span>
            {onTogglePin && (
              <button
                className={`session-pin-btn${isPinned ? " session-pin-btn--pinned" : ""}`}
                onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
                title={isPinned ? "Unpin" : "Pin"}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2" fill={isPinned ? "currentColor" : "none"}/>
                  <path d="M5 5.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            <button
              className="session-archive-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (isEmptySession(s)) {
                  modus.archiveSession(s.id).catch(() => {});
                } else {
                  onArchive(s.id);
                }
              }}
              title="Archive session"
            >
              &times;
            </button>
          </span>
        </div>
      </div>
    </div>
  );
});
