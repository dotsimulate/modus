import { useState, useEffect, useCallback } from "react";

export type View = "chat" | "dashboard" | "memory" | "schedules" | "git";

export function useHashRouter() {
  const [view, setView] = useState<View>(() => {
    const h = window.location.hash;
    if (h === "#dashboard") return "dashboard";
    if (h === "#memory") return "memory";
    if (h === "#schedules") return "schedules";
    if (h === "#git") return "git";
    return "chat";
  });

  useEffect(() => {
    const onHash = () => {
      const h = window.location.hash;
      if (h === "#dashboard") setView("dashboard");
      else if (h === "#memory") setView("memory");
      else if (h === "#schedules") setView("schedules");
      else if (h === "#git") setView("git");
      else setView("chat");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((target: View) => {
    if (target === "chat") window.location.hash = "";
    else window.location.hash = target;
    setView(target);
  }, []);

  return { view, navigate };
}
