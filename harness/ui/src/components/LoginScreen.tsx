import { useState, useRef, useEffect, useCallback } from "react";
import { modus, setAuthToken } from "../modusClient";
import { MoLogo } from "./MoLogo";

const GLYPHS = "0123456789abcdefnrstiouxlm{}[]()=></:;.&|!?#@$%~^+*";
const WORDS = [
  "dot","td","dat","lab",
  "fn","rx","ts","css","jsx","api","src","dom","ref","0x",
  "if","db","io","cb","fs","ui","px","ms","ws","id","ev","async","py",
  "ext","tox","toe",
];
function randomGlyph() { return GLYPHS[Math.floor(Math.random() * GLYPHS.length)]; }

function buildNoise(typed: number, total: number) {
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    if (i < typed) { out.push("*"); continue; }
    // ~15% chance to drop a word fragment if it fits
    if (Math.random() < 0.15) {
      const w = WORDS[Math.floor(Math.random() * WORDS.length)];
      if (i + w.length <= total) {
        for (const ch of w) out.push(ch);
        i += w.length - 1;
        continue;
      }
    }
    out.push(randomGlyph());
  }
  return out.join("");
}

const NOISE_LEN = 14;

function GlyphField({
  inputRef,
  value,
  onChange,
  autoComplete,
  label,
  onSubmit,
  success,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  label: string;
  onSubmit?: () => void;
  success?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [noise, setNoise] = useState(() => buildNoise(0, NOISE_LEN));
  const [caretOn, setCaretOn] = useState(true);

  const typed = value.length;

  // cycle trailing noise glyphs — always running
  useEffect(() => {
    const speed = focused ? 250 : hovered ? 400 : 800;
    const id = setInterval(() => setNoise(buildNoise(typed, NOISE_LEN)), speed);
    return () => clearInterval(id);
  }, [typed, focused, hovered]);

  // blink caret when focused
  useEffect(() => {
    if (!focused) { setCaretOn(true); return; }
    const id = setInterval(() => setCaretOn((v) => !v), 530);
    return () => clearInterval(id);
  }, [focused]);

  // build display: bullets + cursor glyph + trailing noise
  const display = [];
  for (let i = 0; i < NOISE_LEN; i++) {
    if (i < typed) {
      display.push(<span key={i} className="login-noise-locked">*</span>);
    } else if (i === typed && focused) {
      display.push(<span key={i} className={`login-noise-cursor${caretOn ? " on" : ""}`}>_</span>);
    } else {
      display.push(<span key={i} className="login-noise-glyph">{noise[i] ?? randomGlyph()}</span>);
    }
  }

  return (
    <div
      className={`login-field login-field-pw${value ? " has-value" : ""}${focused ? " is-focused" : ""}${hovered && !focused ? " is-hovered" : ""}${success ? " is-success" : ""}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={() => inputRef?.current?.focus()}
    >
      <input
        ref={inputRef}
        className="login-input login-input-pw"
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) onSubmit(); }}
        autoComplete={autoComplete}
        aria-label={label}
      />
      <span className="login-label login-label-pin">{label}</span>
      <span className="login-noise" aria-hidden>{display}</span>
      <span className="login-line" />
    </div>
  );
}

type Props = {
  onAuth: (name: string) => void;
  isSetup?: boolean;
  pinOptional?: boolean;
  savedName?: string;
};

export function LoginScreen({ onAuth, isSetup, pinOptional, savedName }: Props) {
  const [name, setName] = useState(savedName ?? "");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [pinSuccess, setPinSuccess] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);

  const nameLocked = !isSetup && !!savedName;

  useEffect(() => {
    if (nameLocked) pinRef.current?.focus();
    else if (!name) nameRef.current?.focus();
    else pinRef.current?.focus();
  }, []);

  // Any keyboard activity focuses the passcode field — but not when user field is active
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        active?.getAttribute("contenteditable") === "true"
      ) return;
      pinRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const submitLogin = useCallback(async () => {
    if (!name.trim()) { setError("name required"); nameRef.current?.focus(); return; }
    if (!pin.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const token = await modus.verifyPin(pin.trim(), name.trim());
      setAuthToken(token);
      setPinSuccess(true);
      setTimeout(() => onAuth(name.trim()), 1000);
    } catch {
      setError("wrong pin");
      setPin("");
      pinRef.current?.focus();
      setLoading(false);
    }
  }, [name, pin, loading, onAuth]);

  const submitSetup = useCallback(async () => {
    if (!name.trim()) { setError("name required"); nameRef.current?.focus(); return; }
    if (loading) return;
    const wantsPin = !!pin.trim() || !!confirm.trim();
    if (!wantsPin && !pinOptional) return;
    if (wantsPin && pin.trim().length < 4) { setError("at least 4 characters"); return; }
    if (wantsPin && pin !== confirm) { setError("pins don't match"); setConfirm(""); return; }
    setLoading(true);
    setError("");
    try {
      if (wantsPin) {
        const token = await modus.setupNewPin(pin.trim(), name.trim());
        setAuthToken(token);
        setPinSuccess(true);
        setTimeout(() => onAuth(name.trim()), 1000);
      } else {
        await modus.setUserName(name.trim());
        onAuth(name.trim());
      }
    } catch {
      setError("setup failed");
      setLoading(false);
    }
  }, [name, pin, confirm, loading, onAuth, pinOptional]);

  const setupWantsPin = !!pin.trim() || !!confirm.trim();
  const setupSubmitDisabled = loading
    || !name.trim()
    || (!pinOptional && (!pin.trim() || !confirm.trim()))
    || (setupWantsPin && (!pin.trim() || !confirm.trim()));
  const setupSubmitLabel = loading ? "..." : setupWantsPin ? "set PIN" : "continue";

  return (
    <div className="login-screen">
      <div className="login-glow" />
      <div className="login-box">
        <div className="login-logo"><MoLogo size={36} /></div>
        {isSetup && (
          <div className="login-subtitle">
            {pinOptional ? "set your name; PIN optional" : "choose a PIN to secure browser access"}
          </div>
        )}
        {isSetup ? (
          <form className="login-form-stack" onSubmit={(e) => { e.preventDefault(); submitSetup(); }}>
            <div className={`login-field login-field-user${name ? " has-value" : ""}`}>
              <input
                ref={nameRef}
                className="login-input login-input-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="username"
              />
              <span className="login-label">user</span>
              <span className="login-line" />
            </div>
            <GlyphField
              inputRef={pinRef}
              value={pin}
              onChange={setPin}
              autoComplete="new-password"
              label={pinOptional ? "PIN optional" : "PIN"}
            />
            <GlyphField
              inputRef={confirmRef}
              value={confirm}
              onChange={setConfirm}
              autoComplete="new-password"
              onSubmit={submitSetup}
              label="confirm PIN"
            />
            {confirm && pin && confirm !== pin.slice(0, confirm.length) && (
              <div className="login-hint">pins don't match</div>
            )}
            {confirm && pin && confirm === pin && (
              <div className="login-hint login-hint-ok">confirmed</div>
            )}
            <button
              className="login-btn"
              type="submit"
              disabled={setupSubmitDisabled}
            >
              {setupSubmitLabel}
            </button>
          </form>
        ) : (
          <form className="login-form-stack" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
            {nameLocked ? (
              <div className="login-name-label">{name}</div>
            ) : (
              <div className={`login-field login-field-user${name ? " has-value" : ""}`}>
                <input
                  ref={nameRef}
                  className="login-input login-input-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="username"
                />
                <span className="login-label">user</span>
                <span className="login-line" />
              </div>
            )}
            <GlyphField
              inputRef={pinRef}
              value={pin}
              onChange={setPin}
              autoComplete="current-password"
              label="PIN"
              onSubmit={submitLogin}
              success={pinSuccess}
            />
            <button className="login-btn" type="submit" disabled={loading || !name.trim() || !pin.trim()} style={{ display: "none" }} />
          </form>
        )}
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}
