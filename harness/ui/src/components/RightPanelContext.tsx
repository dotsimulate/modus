import { createContext, useContext } from "react";
import type { Message } from "../../../sdk/index";

export type RightPanelContextValue = {
  messages: Message[];
  sessionId: string | null;
  browserPath: string | null;
  activeWidgetId: string | null;
  setBrowserPath: (path: string | null) => void;
  requestOpen: () => void;
};

const RightPanelContext = createContext<RightPanelContextValue | null>(null);

export function RightPanelContextProvider({
  value,
  children,
}: {
  value: RightPanelContextValue;
  children: React.ReactNode;
}) {
  return (
    <RightPanelContext.Provider value={value}>
      {children}
    </RightPanelContext.Provider>
  );
}

export function useRightPanelContext(): RightPanelContextValue {
  const value = useContext(RightPanelContext);
  if (!value) {
    throw new Error("useRightPanelContext must be used inside RightPanelContextProvider");
  }
  return value;
}

/** Non-throwing variant — returns null when outside a RightPanelContextProvider. */
export function useOptionalRightPanelContext(): RightPanelContextValue | null {
  return useContext(RightPanelContext);
}
