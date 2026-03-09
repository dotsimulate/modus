import { useState, useRef, useEffect, useCallback } from "react";

const STORAGE_KEY = "mo-chat-settings";

type ChatSettings = {
  fontScale: number;
  chatWidth: number;
};

const DEFAULTS: ChatSettings = { fontScale: 100, chatWidth: 840 };

function load(): ChatSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

function save(s: ChatSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function apply(s: ChatSettings) {
  const root = document.documentElement;
  root.style.setProperty("--chat-max-width", `${s.chatWidth}px`);
  root.style.setProperty("--font-scale", `${s.fontScale / 100}`);
}

// Apply saved settings on module load
apply(load());

export function ChatSettings() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ChatSettings>(load);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  const update = useCallback((patch: Partial<ChatSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      apply(next);
      return next;
    });
  }, []);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
    } else {
      // Snapshot button position so the popover stays fixed in place
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
      }
      setOpen(true);
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const isDefault = settings.fontScale === DEFAULTS.fontScale && settings.chatWidth === DEFAULTS.chatWidth;

  return (
    <div className="chat-settings" ref={ref}>
      <button
        ref={btnRef}
        className={`chat-settings-btn${open ? " active" : ""}`}
        onClick={toggle}
        title="Chat display settings"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <line x1="1" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <line x1="1" y1="12" x2="15" y2="12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          <circle cx="5" cy="4" r="1.5" fill="var(--bg, #000)" stroke="currentColor" strokeWidth="1.2"/>
          <circle cx="11" cy="12" r="1.5" fill="var(--bg, #000)" stroke="currentColor" strokeWidth="1.2"/>
        </svg>
      </button>
      {open && pos && (
        <div
          className="chat-settings-popover"
          style={{ top: pos.top, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="chat-settings-row">
            <span className="chat-settings-label">font</span>
            <input
              type="range" min={75} max={175} step={5}
              value={settings.fontScale}
              onChange={(e) => update({ fontScale: +e.target.value })}
            />
            <span className="chat-settings-value">{settings.fontScale}%</span>
          </div>
          <div className="chat-settings-row">
            <span className="chat-settings-label">width</span>
            <input
              type="range" min={500} max={1600} step={20}
              value={settings.chatWidth}
              onChange={(e) => update({ chatWidth: +e.target.value })}
            />
            <span className="chat-settings-value">{settings.chatWidth}</span>
          </div>
          {!isDefault && (
            <button className="chat-settings-reset" onClick={() => update(DEFAULTS)}>reset</button>
          )}
        </div>
      )}
    </div>
  );
}
