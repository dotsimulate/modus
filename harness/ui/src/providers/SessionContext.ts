import { createContext, useContext } from "react";
import type { Session, SessionInfo, Attachment, MoveBinding } from "../../../sdk/index";
import type { AgentConfigState } from "../components/AgentConfig";

export type QueuedMessage = {
  text: string;
  attachments: Attachment[];
  /** True when the message has already been committed to the backend queue (survives navigation) */
  serverQueued?: boolean;
  dispatchId?: string;
};

type SessionContextValue = {
  activeSession: Session | null;
  serverSessions: SessionInfo[];
  handleInputChange: (text: string) => void;
  send: (attachments: Attachment[], textOverride?: string, moves?: MoveBinding[]) => Promise<void>;
  stop: () => Promise<void>;
  stopTask: (taskId: string) => Promise<void>;
  newSession: (profileOverride?: string) => Promise<string | null>;
  selectSession: (id: string) => Promise<void>;
  archiveSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  handlePermissionResponse: (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => Promise<void>;
  queuedMessage: QueuedMessage | null;
  cancelQueued: () => void;
  updateActiveSessionConfig: (config: AgentConfigState) => Promise<void>;
  updateActiveSessionProfile: (profile: string) => void;
  branchFromMessage: (seq: number, prefill?: string) => Promise<void>;
};

export const SessionContext = createContext<SessionContextValue>(null!);
export const useSession = () => useContext(SessionContext);
