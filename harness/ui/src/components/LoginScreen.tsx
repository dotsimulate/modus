import { useState, useRef, useEffect } from "react";
import { verifyPin, setupNewPin, setAuthToken } from "../api";

type Props = {
  onAuth: (name: string) => void;
  /** true = no PIN exists yet, show setup form */
  isSetup?: boolean;
  /** pre-filled name from server (returning user) */
  savedName?: string;
};

export function LoginScreen({ onAuth, isSetup, savedName }: Props) {
  const [name, setName] = useState(savedName ?? "");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const pinRef = useRef<HTMLInputElement>(null);

  const nameLocked = !isSetup && !!savedName;

  useEffect(() => {
    if (nameLocked) pinRef.current?.focus();
    else if (!name) nameRef.current?.focus();
    else pinRef.current?.focus();
  }, []);

  const submitLogin = async () => {
    if (!name.trim()) { setError("name required"); nameRef.current?.focus(); return; }
    if (!pin.trim() || loading) return;
    setLoading(true);
    setError("");
    try {
      const token = await verifyPin(pin.trim(), name.trim());
      setAuthToken(token);
      onAuth(name.trim());
    } catch {
      setError("wrong pin");
      setPin("");
      pinRef.current?.focus();
    } finally {
      setLoading(false);
    }
  };

  const submitSetup = async () => {
    if (!name.trim()) { setError("name required"); nameRef.current?.focus(); return; }
    if (!pin.trim() || loading) return;
    if (pin.trim().length < 4) { setError("at least 4 characters"); return; }
    if (pin !== confirm) { setError("pins don't match"); setConfirm(""); return; }
    setLoading(true);
    setError("");
    try {
      const token = await setupNewPin(pin.trim(), name.trim());
      setAuthToken(token);
      onAuth(name.trim());
    } catch {
      setError("setup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <div className="login-title">harness</div>
        {isSetup && <div className="login-subtitle">set a pin to secure access</div>}
        {isSetup ? (
          <form className="login-form-stack" onSubmit={(e) => { e.preventDefault(); submitSetup(); }}>
            <input
              ref={nameRef}
              className="login-input login-input-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="your name"
              autoComplete="username"
            />
            <input
              ref={pinRef}
              className="login-input"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="choose a pin"
              autoComplete="new-password"
            />
            <input
              className="login-input"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="confirm pin"
              autoComplete="new-password"
            />
            <button className="login-btn" type="submit" disabled={loading || !name.trim() || !pin.trim() || !confirm.trim()}>
              {loading ? "..." : "set pin"}
            </button>
          </form>
        ) : (
          <form className="login-form-stack" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
            {nameLocked ? (
              <div className="login-name-label">{name}</div>
            ) : (
              <input
                ref={nameRef}
                className="login-input login-input-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="your name"
                autoComplete="username"
              />
            )}
            <input
              ref={pinRef}
              className="login-input"
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="PIN"
              autoComplete="current-password"
            />
            <button className="login-btn" type="submit" disabled={loading || !name.trim() || !pin.trim()}>
              {loading ? "..." : "enter"}
            </button>
          </form>
        )}
        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  );
}
