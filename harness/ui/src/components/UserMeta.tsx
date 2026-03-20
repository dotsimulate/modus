import { memo } from "react";
import type { Message } from "../api";

type Props = {
  msg: Message;
  onBranch?: (seq: number, prefill?: string) => void;
};

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
