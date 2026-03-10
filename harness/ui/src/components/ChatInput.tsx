import { useEffect, useRef, useState, useCallback } from "react";
import type { SessionStatus, Attachment } from "../api";
import { PromptPicker } from "./PromptPicker";

/** In-memory history of sent messages — survives re-renders, cleared on page reload */
const sentHistory: string[] = [];
const MAX_HISTORY = 50;

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments: Attachment[]) => void;
  onStop: () => void;
  sessionStatus: SessionStatus | null;
  disabled: boolean;
  placeholder?: string;
  activeToolName?: string;
  activeToolElapsed?: number;
};

/** Read a File as base64 (strip the data: prefix) */
function fileToBase64(file: File): Promise<{ data: string; mediaType: string; name: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const data = result.split(",")[1]; // strip "data:image/png;base64,"
      resolve({ data, mediaType: file.type || "image/png", name: file.name || "image" });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ChatInput({
  value, onChange, onSend, onStop,
  sessionStatus, disabled, placeholder,
  activeToolName, activeToolElapsed,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const historyIndex = useRef(-1);
  const draft = useRef("");
  const isActive = sessionStatus === "running" || sessionStatus === "starting";

  // Prompt picker slash shortcut
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerForceOpen, setPickerForceOpen] = useState(0);

  // Attachment state
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  // Elapsed timer for streaming bar
  const [elapsed, setElapsed] = useState(0);
  const timerStart = useRef(0);
  useEffect(() => {
    if (isActive) {
      timerStart.current = Date.now();
      setElapsed(0);
      const id = setInterval(() => setElapsed(Date.now() - timerStart.current), 1000);
      return () => clearInterval(id);
    }
  }, [isActive]);
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const timerText = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [value]);

  // Auto-focus input when component mounts or session changes
  useEffect(() => {
    if (!disabled && ref.current) {
      ref.current.focus();
    }
  }, [sessionStatus, disabled]);

  // Global Escape to stop — works regardless of focus, but not when picker is open
  useEffect(() => {
    if (!isActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pickerOpen) { e.preventDefault(); onStop(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, onStop, pickerOpen]);

  // ── File processing ──

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
    if (imageFiles.length === 0) return;

    const results = await Promise.all(imageFiles.map(fileToBase64));
    setAttachments((prev) => [
      ...prev,
      ...results.map((r): Attachment => ({
        type: "image",
        mediaType: r.mediaType,
        data: r.data,
        name: r.name,
      })),
    ]);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Drag and Drop ──

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (e.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    addImageFiles(files);
  }, [addImageFiles]);

  // ── Clipboard paste ──

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageItems: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type)) {
        const file = item.getAsFile();
        if (file) imageItems.push(file);
      }
    }
    if (imageItems.length > 0) {
      e.preventDefault(); // prevent default paste when we have images
      addImageFiles(imageItems);
    }
    // If no images, let the default text paste happen
  }, [addImageFiles]);

  // ── Send ──

  const handleSend = () => {
    const text = value.trim();
    if (!text && attachments.length === 0) return;
    if (text) {
      sentHistory.push(text);
      if (sentHistory.length > MAX_HISTORY) sentHistory.shift();
      historyIndex.current = -1;
      draft.current = "";
    }
    onSend(attachments);
    setAttachments([]);
  };

  // Catch "/" via beforeinput — works even when keyDown doesn't fire (IME, dead keys, etc.)
  const handleBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const ie = e.nativeEvent as InputEvent;
    if (ie.data === "/" && !value.trim()) {
      e.preventDefault();
      setPickerForceOpen((n) => n + 1);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
      return;
    }

    // "/" on empty input → open prompt picker
    if (e.key === "/" && !value.trim()) {
      console.log("[DBG] / on empty → incrementing forceOpen");
      e.preventDefault();
      setPickerForceOpen((n) => { console.log("[DBG] forceOpen:", n, "→", n+1); return n + 1; });
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

  const hasContent = value.trim() || attachments.length > 0;

  return (
    <div
      className={`chat-input-area${isDragging ? " drag-active" : ""}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="drop-overlay">drop images here</div>
      )}

      <div className={`streaming-bar${isActive ? "" : " streaming-idle"}`}>
        <span className={`streaming-indicator${activeToolName ? " indicator-tool" : ""}`} />
        <span>{isActive ? statusText : "idle"}</span>
        <span className="streaming-timer">{isActive ? timerText : ""}</span>
        <button className="stop-inline" onClick={onStop} disabled={!isActive}>stop</button>
      </div>

      {attachments.length > 0 && (
        <div className="attachment-strip">
          {attachments.map((att, i) => (
            <div key={i} className="attachment-thumb">
              <img
                src={`data:${att.mediaType};base64,${att.data}`}
                alt={att.name || "attachment"}
              />
              <button
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="input-row">
        <div className="chat-textarea-wrap">
          <textarea
            ref={ref}
            className="chat-textarea"
            placeholder={placeholder ?? "message... (drop or paste images)"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBeforeInput={handleBeforeInput}
            onPaste={handlePaste}
            rows={1}
            disabled={disabled}
          />
          <div className="chat-picker">
            <PromptPicker
              forceOpen={pickerForceOpen}
              onOpenChange={(isOpen) => {
                setPickerOpen(isOpen);
                if (!isOpen) {
                  ref.current?.focus();
                }
              }}
              onInject={(text) => {
                const ta = ref.current;
                const existing = value;
                if (!existing.trim()) {
                  onChange(text);
                } else if (text.startsWith("/")) {
                  onChange(text + "\n" + existing);
                } else {
                  const pos = ta?.selectionStart ?? existing.length;
                  const before = existing.slice(0, pos);
                  const after = existing.slice(pos);
                  const sep = before && !before.endsWith("\n") ? "\n" : "";
                  onChange(before + sep + text + after);
                }
                ta?.focus();
              }}
            />
          </div>
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!hasContent || disabled}
          >
            send
          </button>
        </div>
      </div>
    </div>
  );
}
