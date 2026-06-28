import { createContext, useContext } from "react";

type AuthContextValue = {
  userName: string | null;
  authRequired: boolean;
  pinEnabled: boolean;
  handleLock: () => void;
};

export const AuthContext = createContext<AuthContextValue>(null!);
export const useAuth = () => useContext(AuthContext);
