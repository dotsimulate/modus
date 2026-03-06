import { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "../providers/SessionProvider";

type Props = {
  message: QueuedMessageType;
  onCancel: () => void;
};

export function QueuedMessage({ message, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasImages = message.attachments.length > 0;
  const preview = message.text.length > 60
    ? message.text.slice(0, 60) + "..."
    : message.text;

  return (
    <div className="queued-message">
      <div className="queued-message-header" onClick={() => setExpanded(!expanded)}>
        <span className="queued-message-indicator">
          <span className="queued-message-dot" />
        </span>
        <span className="queued-message-label">queued</span>
        <span className="queued-message-preview">
          {hasImages && `[${message.attachments.length} img] `}
          {preview}
        </span>
        <button className="queued-message-cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
          cancel
        </button>
      </div>
      {expanded && (
        <div className="queued-message-body">
          {message.text}
        </div>
      )}
    </div>
  );
}
