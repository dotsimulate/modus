import type { SessionInfo } from "../../api";

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

export function SessionItem({ session: s, active, onSelect, onArchive }: Props) {
  return (
    <div
      className={`session-item ${active ? "active" : ""}`}
      onClick={() => onSelect(s.id)}
    >
      <div className="session-item-preview">
        <span className={`dash-dot ${statusDotClass(s.status)}`} />
        <span className="session-item-text">{s.last_prompt ?? s.preview}</span>
      </div>
      <div className="session-item-meta">
        <span className="session-meta-left">
          <span className="session-profile-tag">
            {s.profile ?? "default"}
          </span>
          <span>${s.total_cost_usd.toFixed(3)}</span>
          <span>{s.message_count}msg</span>
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
