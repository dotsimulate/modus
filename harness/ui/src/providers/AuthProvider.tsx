import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { authStatus, clearAuthToken, lockAll, checkToken } from "../api";
import { LoginScreen } from "../components/LoginScreen";

type AuthContextValue = {
  userName: string | null;
  handleLock: () => void;
};

const AuthContext = createContext<AuthContextValue>(null!);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<"checking" | "login" | "setup" | "ok">("checking");
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    if (authState !== "checking") return;
    authStatus()
      .then(async ({ required, setup, name }) => {
        if (name) setUserName(name);
        if (setup) { setAuthState("setup"); return; }
        if (!required) { setAuthState("ok"); return; }
        const existing = localStorage.getItem("harness_token");
        if (existing) {
          try {
            await checkToken();
            setAuthState("ok");
            return;
          } catch {
            clearAuthToken();
          }
        }
        setAuthState("login");
      })
      .catch(() => setAuthState("ok"));
  }, [authState]);

  // Poll to detect server-side lock
  useEffect(() => {
    if (authState !== "ok") return;
    if (!localStorage.getItem("harness_token")) return;
    const interval = setInterval(async () => {
      try {
        await checkToken();
      } catch {
        clearAuthToken();
        setAuthState("checking");
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [authState]);

  const handleAuth = useCallback((name: string) => {
    setUserName(name || null);
    setAuthState("ok");
  }, []);

  const handleLock = useCallback(() => {
    lockAll().catch(() => {});
    clearAuthToken();
    setUserName(null);
    setAuthState("checking");
  }, []);

  if (authState === "checking") return null;
  if (authState === "setup") return <LoginScreen isSetup onAuth={handleAuth} />;
  if (authState === "login") return <LoginScreen savedName={userName ?? undefined} onAuth={handleAuth} />;

  return (
    <AuthContext.Provider value={{ userName, handleLock }}>
      {children}
    </AuthContext.Provider>
  );
}
