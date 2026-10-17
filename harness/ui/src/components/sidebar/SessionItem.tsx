import { memo, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { BranchPreview, SessionInfo } from "../../../../sdk/index";
import { modus } from "../../modusClient";
import { useSessionActions } from "../../providers/SessionContext";
import { useSessionState } from "../../sessionStore";
import { sessionActivityAt as activityAt } from "../../sessionActivity";
import { hasUnreadReply } from "../../session-read-state";
import { formatSidebarProviderStat, getLatestAssistantUsage } from "../providerStats";
import { compactModelName, isEmptySession, sessionDisplayText, timeAgo } from "../../utils/format";
import { useContextMenu } from "../ContextMenu";
import { BranchReviewDialog } from "../BranchReviewDialog";
import { buildSessionMenuItems, isSessionBusy, latestBranchSeq } from "./sessionMenu";

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

type BranchReview = {
  seq: number | null;
  preview: BranchPreview | null;
  loading: boolean;
  applying: boolean;
  error: string | null;
};

const errorText = (err: unknown) => err instanceof Error ? err.message : String(err);

export const SessionItem = memo(function SessionItem({ session: s, active, onSelect, onArchive, draftInput, tags, onTogglePin }: Props) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const ctxMenu = useContextMenu();
  const { refreshSessions } = useSessionActions();
  const [branch, setBranch] = useState<BranchReview | null>(null);
  // Bumped on every open and cancel, so a review dismissed mid-load stays dismissed.
  const branchRequestRef = useRef(0);
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
  const unread = hasUnreadReply(s);

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

  const archive = () => {
    if (isEmptySession(s)) {
      modus.archiveSession(s.id).catch(() => {});
    } else {
      onArchive(s.id);
    }
  };

  const openBranchReview = async () => {
    const request = ++branchRequestRef.current;
    setBranch({ seq: null, preview: null, loading: true, applying: false, error: null });
    try {
      // Several turns back, so a trailing prompt that failed still leaves a reply to branch at.
      const snapshot = await modus.getSessionHistorySnapshot(s.id, { limit: 10, details: "summary" });
      if (!Array.isArray(snapshot.messages)) throw new Error("Could not load this session's history.");
      const seq = latestBranchSeq(snapshot.messages);
      if (seq == null) throw new Error("This session has no completed reply to branch from.");
      const preview = await modus.previewBranch(s.id, seq);
      if (branchRequestRef.current !== request) return;
      setBranch({ seq, preview, loading: false, applying: false, error: null });
    } catch (err) {
      if (branchRequestRef.current !== request) return;
      setBranch({ seq: null, preview: null, loading: false, applying: false, error: errorText(err) });
    }
  };

  const cancelBranchReview = () => {
    branchRequestRef.current++;
    setBranch(null);
  };

  const confirmBranch = async () => {
    if (!branch || branch.seq == null || !branch.preview?.conversation.supported) return;
    setBranch({ ...branch, applying: true, error: null });
    try {
      const result = await modus.branchSession(s.id, branch.seq, { confirmed: true });
      setBranch(null);
      await refreshSessions();
      onSelect(result.sessionId);
    } catch (err) {
      setBranch((prev) => prev && { ...prev, applying: false, error: errorText(err) });
    }
  };

  const openMenu = (e: React.MouseEvent) => {
    if (editing) return; // the title input keeps its native edit menu
    ctxMenu.open(e, buildSessionMenuItems({
      active,
      pinned: isPinned,
      canBranch: s.message_count > 0 && !isSessionBusy(status),
      onOpen: () => onSelect(s.id),
      onRename: startEdit,
      onTogglePin,
      onBranch: () => void openBranchReview(),
      onCopyId: () => { void navigator.clipboard?.writeText(s.id).catch(() => {}); },
      onArchive: archive,
    }));
  };

  // The menu and dialog render beside the row, not inside it: portal events still
  // bubble through the React tree, and the row's onClick would open the session.
  return (
    <>
      <div
        className={`session-item ${active ? "active" : ""}${unread ? " session-item--unread" : ""}${ctxMenu.isOpen ? " session-item--ctx" : ""}`}
        onClick={() => !editing && onSelect(s.id)}
        onContextMenu={openMenu}
      >
        <div className="session-item-preview">
          {unread && <span className="session-unread-dot" role="img" aria-label="Unread reply" title="Unread reply" />}
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
                  archive();
                }}
                title="Archive session"
              >
                &times;
              </button>
            </span>
          </div>
        </div>
      </div>
      {ctxMenu.portal}
      {branch && createPortal(
        <BranchReviewDialog
          restoreCode={false}
          loading={branch.loading}
          applying={branch.applying}
          error={branch.error}
          preview={branch.preview}
          provider={provider}
          onCancel={cancelBranchReview}
          onConfirm={() => void confirmBranch()}
        />,
        document.body,
      )}
    </>
  );
});
