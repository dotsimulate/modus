import { useEffect, useRef, useState, useCallback, useId } from "react";
import type { SessionStatus, Attachment } from "../api";
import type { ActivateMoveResult } from "../api";
import { PromptPicker } from "./PromptPicker";
import { activateComposer, registerComposer, useComposerActions } from "../client-extensions";

/** In-memory history of sent messages — survives re-renders, cleared on page reload */
const sentHistory: string[] = [];
const MAX_HISTORY = 50;

const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSend: (attachments: Attachment[], textOverride?: string) => void;
  onStop: () => void;
  sessionStatus: SessionStatus | null;
  disabled: boolean;
  placeholder?: string;
  sessionId?: string;
  projectCwd?: string;
  userProfile?: string;
  onMoveActivated?: (result: ActivateMoveResult) => void;
  autoFocus?: boolean;
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

function ComposerActionIcon({ icon }: { icon?: "mic" }) {
  if (icon === "mic") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M7 1.75a2 2 0 0 0-2 2v3.5a2 2 0 1 0 4 0v-3.5a2 2 0 0 0-2-2Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M3.75 6.75a3.25 3.25 0 0 0 6.5 0M7 10.5v1.75M5.25 12.25h3.5"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return null;
}

export function ChatInput({
  value, onChange, onSend, onStop,
  sessionStatus, disabled, placeholder, sessionId, projectCwd, userProfile, onMoveActivated, autoFocus = false,
}: Props) {
  const composerId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const sessionIdRef = useRef(sessionId);
  const projectCwdRef = useRef(projectCwd);
  const userProfileRef = useRef(userProfile);
  const handleSendRef = useRef<(textOverride?: string) => void>(() => {});
  const composerActions = useComposerActions(composerId);
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

  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
    sessionIdRef.current = sessionId;
    projectCwdRef.current = projectCwd;
    userProfileRef.current = userProfile;
  }, [onChange, projectCwd, sessionId, userProfile, value]);

  useEffect(() => {
    const ta = ref.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [value]);

  // Focus when the visible chat session changes or the chat view becomes active.
  useEffect(() => {
    if (autoFocus && !disabled && ref.current) {
      ref.current.focus();
    }
  }, [autoFocus, disabled, sessionId]);

  useEffect(() => {
    return registerComposer({
      id: composerId,
      getSnapshot: () => ({
        sessionId: sessionIdRef.current,
        cwd: projectCwdRef.current,
        userProfile: userProfileRef.current,
        draft: valueRef.current,
      }),
      focus: () => ref.current?.focus(),
      setDraft: (text: string) => {
        onChangeRef.current(text);
      },
      insertText: (text: string) => {
        const ta = ref.current;
        const current = valueRef.current;
        if (!ta) {
          onChangeRef.current(current + text);
          return;
        }
        const start = ta.selectionStart ?? current.length;
        const end = ta.selectionEnd ?? current.length;
        onChangeRef.current(current.slice(0, start) + text + current.slice(end));
        requestAnimationFrame(() => {
          ta.focus();
          const pos = start + text.length;
          ta.setSelectionRange(pos, pos);
        });
      },
      submit: (text?: string) => {
        handleSendRef.current(text);
      },
    });
  }, [composerId]);

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

  function handleSend(textOverride?: string) {
    const text = (textOverride ?? value).trim();
    if (!text && attachments.length === 0) return;
    if (text) {
      sentHistory.push(text);
      if (sentHistory.length > MAX_HISTORY) sentHistory.shift();
      historyIndex.current = -1;
      draft.current = "";
    }
    onSend(attachments, text);
    setAttachments([]);
  }

  handleSendRef.current = handleSend;

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
      e.preventDefault();
      setPickerForceOpen((n) => n + 1);
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

  const hasContent = value.trim() || attachments.length > 0;

  // Icon-only actions (no label) go to top-left corner; labelled actions stay in the button row
  const iconActions = composerActions.filter((a) => a.icon && !a.label);
  const buttonActions = composerActions.filter((a) => !a.icon || !!a.label);
  const buttonStatuses = buttonActions.filter((a) => a.status?.label);

  const isRecording = composerActions.some((a) => a.status?.tone === "active");
  const isFinishing = composerActions.some((a) => a.status?.tone === "busy");
  const statusDotTone = isRecording ? "active" : isFinishing ? "busy" : null;

  const wrapClass = [
    "chat-textarea-wrap",
    isRecording ? "is-recording" : "",
    isFinishing ? "is-finishing" : "",
    iconActions.length > 0 ? "has-icon-actions" : "",
  ].filter(Boolean).join(" ");

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
        <div className={wrapClass}>
          {iconActions.length > 0 && (
            <div className="composer-icon-actions">
              {iconActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className="composer-icon-btn"
                  onClick={() => { void action.perform(); }}
                  disabled={disabled || action.disabled}
                  title={action.title ?? action.extensionId}
                  aria-label={action.title ?? action.extensionId}
                >
                  <ComposerActionIcon icon={action.icon} />
                </button>
              ))}
            </div>
          )}
          {statusDotTone && (
            <div className={`composer-status-dot composer-status-dot--${statusDotTone}`} />
          )}
          <textarea
            ref={ref}
            className="chat-textarea"
            placeholder={placeholder ?? "message... (drop or paste images)"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onBeforeInput={handleBeforeInput}
            onPaste={handlePaste}
            onFocus={() => activateComposer(composerId)}
            rows={1}
            disabled={disabled}
          />
          <div className="chat-picker">
            <PromptPicker
              forceOpen={pickerForceOpen}
              sessionId={sessionId}
              projectCwd={projectCwd}
              userProfile={userProfile}
              onMoveActivated={onMoveActivated}
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
          <div className="chat-controls">
            {buttonStatuses.length > 0 && (
              <div className="composer-status-row">
                {buttonStatuses.map((action) => (
                  <span
                    key={`${action.key}:status`}
                    className={`composer-status composer-status--${action.status?.tone ?? "default"}`}
                  >
                    {action.status?.label}
                  </span>
                ))}
              </div>
            )}
            <div className="composer-button-row">
              {buttonActions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={`composer-action-btn${action.label ? "" : " composer-action-btn--icon"}`}
                  onClick={() => { void action.perform(); }}
                  disabled={disabled || action.disabled}
                  title={action.title ?? action.label ?? action.extensionId}
                  aria-label={action.title ?? action.label ?? action.extensionId}
                >
                  <ComposerActionIcon icon={action.icon} />
                  {action.label ? <span>{action.label}</span> : null}
                </button>
              ))}
              {isActive ? (
                <button className="stop-btn" type="button" onClick={onStop}>
                  stop
                </button>
              ) : (
                <button
                  className="send-btn"
                  type="button"
                  onClick={handleSend}
                  disabled={!hasContent || disabled}
                >
                  send
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
