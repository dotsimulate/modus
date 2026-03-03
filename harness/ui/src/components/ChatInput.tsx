import { useEffect, useRef } from "react";
import type { SessionStatus } from "../types";

/** In-memory history of sent messages — survives re-renders, cleared on page reload */
const sentHistory: string[] = [];
const MAX_HISTORY = 50;

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
  const historyIndex = useRef(-1);
  const draft = useRef("");
  const isActive = sessionStatus === "running" || sessionStatus === "starting";

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [value]);

  // Global Escape to stop — works regardless of focus
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onStop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, onStop]);

  const handleSend = () => {
    const text = value.trim();
    if (text) {
      sentHistory.push(text);
      if (sentHistory.length > MAX_HISTORY) sentHistory.shift();
      historyIndex.current = -1;
      draft.current = "";
    }
    onSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Up arrow at start of input — cycle back through history
    if (e.key === "ArrowUp" && sentHistory.length > 0) {
      const ta = ref.current;
      const atStart = !ta || ta.selectionStart === 0;
      if (atStart) {
        e.preventDefault();
        if (historyIndex.current === -1) draft.current = value;
        const next = historyIndex.current === -1
          ? sentHistory.length - 1
          : Math.max(0, historyIndex.current - 1);
        historyIndex.current = next;
        onChange(sentHistory[next]);
      }
    }

    // Down arrow — cycle forward through history, back to draft
    if (e.key === "ArrowDown" && historyIndex.current !== -1) {
      const ta = ref.current;
      const atEnd = !ta || ta.selectionStart === ta.value.length;
      if (atEnd) {
        e.preventDefault();
        if (historyIndex.current >= sentHistory.length - 1) {
          historyIndex.current = -1;
          onChange(draft.current);
        } else {
          historyIndex.current++;
          onChange(sentHistory[historyIndex.current]);
        }
      }
    }
  };

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
          onClick={handleSend}
          disabled={!value.trim() || disabled}
        >
          send
        </button>
      </div>
    </div>
  );
}
