import { createContext, useContext } from "react";

type AuthContextValue = {
  userName: string | null;
  handleLock: () => void;
};

export const AuthContext = createContext<AuthContextValue>(null!);
export const useAuth = () => useContext(AuthContext);
