import { useState, useEffect, useCallback } from "react";
import { modus } from "../modusClient";
import { clearAuthToken } from "../modusClient";
import { LoginScreen } from "../components/LoginScreen";
import { ModusError } from "../../../sdk/index";
import { AuthContext } from "./AuthContext";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<"checking" | "login" | "setup" | "ok">("checking");
  const [userName, setUserName] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);

  const isAuthFailure = useCallback((err: unknown) => (
    err instanceof ModusError && (err.status === 401 || err.status === 403)
  ), []);

  useEffect(() => {
    if (authState !== "checking") return;
    modus.authStatus()
      .then(async ({ required, setup, name, pinEnabled: hasPin, needsName }) => {
        setAuthRequired(required);
        setPinEnabled(!!hasPin || required);
        if (name) setUserName(name);
        if (setup || (!required && (needsName ?? !name))) { setAuthState("setup"); return; }
        if (!required) { setAuthState("ok"); return; }
        const existing = localStorage.getItem("harness_token");
        if (existing) {
          try {
            await modus.checkToken();
            setAuthState("ok");
            return;
          } catch (err) {
            if (isAuthFailure(err)) {
              clearAuthToken();
            } else {
              setAuthState("ok");
              return;
            }
          }
        }
        setAuthState("login");
      })
      .catch(() => setAuthState("ok"));
  }, [authState, isAuthFailure]);

  useEffect(() => {
    const refresh = () => setAuthState("checking");
    window.addEventListener("modus:auth-changed", refresh);
    return () => window.removeEventListener("modus:auth-changed", refresh);
  }, []);

  // Poll to detect server-side lock
  useEffect(() => {
    if (authState !== "ok") return;
    if (!localStorage.getItem("harness_token")) return;
    const interval = setInterval(async () => {
      try {
        await modus.checkToken();
      } catch (err) {
        if (!isAuthFailure(err)) return;
        clearAuthToken();
        setAuthState("checking");
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authState, isAuthFailure]);

  const handleAuth = useCallback((name: string) => {
    setUserName(name || null);
    setAuthState("ok");
  }, []);

  const handleLock = useCallback(() => {
    modus.lockAll().catch(() => {});
    clearAuthToken();
    setUserName(null);
    setAuthState("checking");
  }, []);

  if (authState === "checking") return null;
  if (authState === "setup") return <LoginScreen isSetup pinOptional={!pinEnabled} onAuth={handleAuth} />;
  if (authState === "login") return <LoginScreen savedName={userName ?? undefined} onAuth={handleAuth} />;

  return (
    <AuthContext.Provider value={{ userName, authRequired, pinEnabled, handleLock }}>
      {children}
    </AuthContext.Provider>
  );
}
