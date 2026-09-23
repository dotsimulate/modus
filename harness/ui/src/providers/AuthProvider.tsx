import { useState, useEffect, useCallback } from "react";
import { modus } from "../modusClient";
import { clearAuthToken, getAuthToken, markBrowserSessionToken, setAuthToken } from "../modusClient";
import { LoginScreen } from "../components/LoginScreen";
import { BackendConnectionScreen } from "../components/BackendTargetManager";
import { ModusError } from "../../../sdk/index";
import { AuthContext } from "./AuthContext";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<"checking" | "login" | "setup" | "unavailable" | "ok">("checking");
  const [userName, setUserName] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [canManagePin, setCanManagePin] = useState(false);

  const isAuthFailure = useCallback((err: unknown) => (
    err instanceof ModusError && (err.status === 401 || err.status === 403)
  ), []);

  const ensureBrowserSession = useCallback(async (): Promise<void> => {
    const existing = getAuthToken();
    if (existing) {
      try {
        const kind = await modus.checkToken();
        if (kind === "browser") {
          markBrowserSessionToken();
          return;
        }
        clearAuthToken();
      } catch (err) {
        if (isAuthFailure(err)) clearAuthToken();
        else throw err;
      }
    }
    const token = await modus.createBrowserSession();
    if (token) setAuthToken(token);
  }, [isAuthFailure]);

  useEffect(() => {
    if (authState !== "checking") return;
    modus.authStatus()
      .then(async ({ required, setup, name, pinEnabled: hasPin, needsName, tokenRequired, canManagePin: localAdmin }) => {
        setAuthRequired(required);
        setPinEnabled(!!hasPin || required);
        setCanManagePin(!!localAdmin);
        if (name) setUserName(name);
        if (setup || (!required && (needsName ?? !name))) { setAuthState("setup"); return; }
        if (!required) {
          if (tokenRequired) await ensureBrowserSession();
          setAuthState("ok");
          return;
        }
        const existing = getAuthToken();
        if (existing) {
          try {
            const kind = await modus.checkToken();
            if (kind === "browser") {
              markBrowserSessionToken();
              setAuthState("ok");
              return;
            }
            clearAuthToken();
          } catch (err) {
            if (isAuthFailure(err)) {
              clearAuthToken();
            } else {
              throw err;
            }
          }
        }
        setAuthState("login");
      })
      .catch(() => setAuthState("unavailable"));
  }, [authState, ensureBrowserSession, isAuthFailure]);

  useEffect(() => {
    const refresh = () => setAuthState("checking");
    window.addEventListener("modus:auth-changed", refresh);
    return () => window.removeEventListener("modus:auth-changed", refresh);
  }, []);

  // Poll to detect server-side lock
  useEffect(() => {
    if (authState !== "ok") return;
    if (!getAuthToken()) return;
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
    void modus.lockAll().then(() => {
      // The local native supervisor credential administers the gate but is not
      // one of the browser sessions being locked.
      if (canManagePin) return;
      clearAuthToken();
      setUserName(null);
      setAuthState("checking");
    }).catch(() => {});
  }, [canManagePin]);

  if (authState === "checking") return null;
  if (authState === "unavailable") return <BackendConnectionScreen message="backend authentication status unavailable" />;
  if (authState === "setup") return <LoginScreen isSetup pinOptional={!pinEnabled} canManagePin={canManagePin} onAuth={handleAuth} />;
  if (authState === "login") return <LoginScreen savedName={userName ?? undefined} onAuth={handleAuth} />;

  return (
    <AuthContext.Provider value={{ userName, authRequired, pinEnabled, handleLock }}>
      {children}
    </AuthContext.Provider>
  );
}
