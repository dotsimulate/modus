import { useState, useRef, useEffect, useCallback } from "react";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import {
  applyInterfaceSettings,
  DEFAULT_INTERFACE_SETTINGS,
  readLocalInterfaceSettings,
  resolveInterfaceSettings,
  type ResolvedInterfaceSettings,
} from "../interface-settings";

export function ChatSettings() {
  const { activeUserProfile, activeUP, refreshUserProfiles } = useProfiles();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ResolvedInterfaceSettings>(readLocalInterfaceSettings);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  useEffect(() => {
    const next = resolveInterfaceSettings(activeUP?.interface);
    setSettings(next);
    applyInterfaceSettings(next);
  }, [activeUP?.interface]);

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const update = useCallback((patch: Partial<ResolvedInterfaceSettings["chat"]>) => {
    setSettings((prev) => {
      const next = { ...prev, chat: { ...prev.chat, ...patch } };
      applyInterfaceSettings(next);
      if (activeUserProfile) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          modus.patchUserProfileUiConfig(activeUserProfile, { interface: next })
            .then(refreshUserProfiles)
            .catch(() => {});
        }, 300);
      }
      return next;
    });
  }, [activeUserProfile, refreshUserProfiles]);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (open) {
      setOpen(false);
    } else {
      // Snapshot button position so the popover stays fixed in place
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        setPos({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
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

  const isDefault =
    settings.chat.fontScale === DEFAULT_INTERFACE_SETTINGS.chat.fontScale &&
    settings.chat.chatWidth === DEFAULT_INTERFACE_SETTINGS.chat.chatWidth &&
    settings.chat.spineEnabled === DEFAULT_INTERFACE_SETTINGS.chat.spineEnabled;

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
          style={{ bottom: pos.bottom, right: pos.right }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="chat-settings-row">
            <span className="chat-settings-label">font</span>
            <input
              type="range" min={75} max={175} step={5}
              value={settings.chat.fontScale}
              onChange={(e) => update({ fontScale: +e.target.value })}
            />
            <span className="chat-settings-value">{settings.chat.fontScale}%</span>
          </div>
          <div className="chat-settings-row">
            <span className="chat-settings-label">width</span>
            <input
              type="range" min={500} max={1600} step={20}
              value={settings.chat.chatWidth}
              onChange={(e) => update({ chatWidth: +e.target.value })}
            />
            <span className="chat-settings-value">{settings.chat.chatWidth}</span>
          </div>
          <div className="chat-settings-row">
            <span className="chat-settings-label">spine</span>
            <button
              type="button"
              className={`chat-settings-toggle${settings.chat.spineEnabled ? " on" : ""}`}
              onClick={() => update({ spineEnabled: !settings.chat.spineEnabled })}
              aria-pressed={settings.chat.spineEnabled}
            >
              <span className="chat-settings-toggle-dot" />
            </button>
            <span className="chat-settings-value">{settings.chat.spineEnabled ? "on" : "off"}</span>
          </div>
          {!isDefault && (
            <button className="chat-settings-reset" onClick={() => update(DEFAULT_INTERFACE_SETTINGS.chat)}>reset</button>
          )}
        </div>
      )}
    </div>
  );
}
