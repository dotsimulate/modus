import { memo } from "react";
import type { Message } from "../api";

type Props = {
  msg: Message;
  onBranch?: (seq: number, prefill?: string) => void;
};

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  if (d.getFullYear() !== now.getFullYear()) {
    return `${date}, ${d.getFullYear()} ${time}`;
  }
  return `${date} ${time}`;
}

export const UserMeta = memo(function UserMeta({ msg, onBranch }: Props) {
  if (!msg.timestamp) return null;

  return (
    <div className="user-meta">
      <span className="user-meta-time">{formatDateTime(msg.timestamp)}</span>
      {onBranch && (
        <span
          className="user-meta-branch"
          onClick={() => msg.seq != null && onBranch(msg.seq, msg.content)}
        >
          branch
        </span>
      )}
    </div>
  );
});
