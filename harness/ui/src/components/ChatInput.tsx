import { useEffect, useRef } from "react";
import type { SessionStatus } from "../types";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  sessionStatus: SessionStatus | null;
  disabled: boolean;
  placeholder?: string;
  activeToolName?: string;
  activeToolElapsed?: number;
};

export function ChatInput({
  value, onChange, onSend, onStop,
  sessionStatus, disabled, placeholder,
  activeToolName, activeToolElapsed,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const isActive = sessionStatus === "running" || sessionStatus === "starting";

  // Build status text
  let statusText = "responding...";
  if (activeToolName) {
    statusText = `${activeToolName}`;
    if (activeToolElapsed != null) statusText += ` (${Math.round(activeToolElapsed)}s)`;
  } else if (sessionStatus === "starting") {
    statusText = "starting...";
  }

  return (
    <div className="chat-input-area">
      {isActive && (
        <div className="streaming-bar">
          <span className="streaming-indicator" />
          <span>{statusText}</span>
          <button className="stop-inline" onClick={onStop}>stop</button>
        </div>
      )}

      <div className="input-row">
        <textarea
          ref={ref}
          className="chat-textarea"
          placeholder={placeholder ?? "message..."}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={disabled}
        />
        <button
          className="send-btn"
          onClick={onSend}
          disabled={!value.trim() || disabled}
        >
          send
        </button>
      </div>
    </div>
  );
}
