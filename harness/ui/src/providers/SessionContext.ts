import { createContext, useContext } from "react";
import type { Session, SessionInfo, SessionProjectSummary, Attachment, MoveBinding } from "../../../sdk/index";
import type { AgentConfigState } from "../components/AgentConfig";
import type { SessionIndexConnectionState } from "../sessionIndexSync";

export type QueuedMessage = {
  text: string;
  attachments: Attachment[];
  /** True when the message has already been committed to the backend queue (survives navigation) */
  serverQueued?: boolean;
  dispatchId?: string;
  /** Set when the user asked to interject but the provider could only queue —
   *  lets the strip say so rather than silently behaving like an ordinary send. */
  steerDeclined?: boolean;
  /** Set when delivery failed. The text is held here rather than lost, and is
   *  never resent automatically — the session may no longer accept it. */
  failed?: string;
};

/** How a send should be delivered when a turn is already running.
 *  "queue" waits for the turn to end; "steer" asks the provider to inject it
 *  now, falling back to the queue where that is not supported. */
export type DeliverMode = "queue" | "steer";

/**
 * Extra send-time decisions that only apply when this message is the one that
 * creates the session. An options bag rather than more positional arguments:
 * the three ChatInput call sites already disagree about the existing ones.
 */
export type SendOpts = {
  /**
   * Agent-profile move bindings the user removed from the composer's pending
   * attachments before sending. Ignored once the session exists, since the
   * profile's inline moves have already gathered by then.
   */
  skipProfileMoves?: string[];
};

type SessionContextValue = {
  activeSession: Session | null;
  serverSessions: SessionInfo[];
  allServerSessions: SessionInfo[];
  /** False until the first session-index fetch resolves. */
  sessionsLoaded: boolean;
  sessionProjects: SessionProjectSummary[];
  sessionIndexConnection: SessionIndexConnectionState;
  handleInputChange: (text: string) => void;
  send: (attachments: Attachment[], textOverride?: string, moves?: MoveBinding[], deliver?: DeliverMode, opts?: SendOpts) => Promise<void>;
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
  branchFromMessage: (seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => Promise<void>;
  branchFromSessionMessage: (sessionId: string, seq: number, prefill?: string, restoreCode?: boolean, providerMessageId?: string) => Promise<void>;
};

export type SessionIndexContextValue = Pick<
  SessionContextValue,
  "serverSessions" | "allServerSessions" | "sessionsLoaded" | "sessionProjects" | "sessionIndexConnection"
>;

export type SessionActionsContextValue = Pick<
  SessionContextValue,
  | "handleInputChange"
  | "send"
  | "stop"
  | "stopTask"
  | "newSession"
  | "selectSession"
  | "archiveSession"
  | "refreshSessions"
  | "handlePermissionResponse"
  | "cancelQueued"
  | "updateActiveSessionConfig"
  | "updateActiveSessionProfile"
  | "branchFromMessage"
  | "branchFromSessionMessage"
>;

export type SessionQueueContextValue = Pick<SessionContextValue, "queuedMessage" | "cancelQueued">;

export const SessionContext = createContext<SessionContextValue>(null!);
export const useSession = () => useContext(SessionContext);

// High-frequency transcript updates must not invalidate the whole application
// shell. These narrow contexts let shell/navigation consumers subscribe only
// to the state they actually render while the legacy aggregate context remains
// available to components that genuinely need the full active session.
export const ActiveSessionIdContext = createContext<string | null>(null);
export const SessionIndexContext = createContext<SessionIndexContextValue>(null!);
export const SessionActionsContext = createContext<SessionActionsContextValue>(null!);
export const SessionQueueContext = createContext<SessionQueueContextValue>(null!);

export const useActiveSessionId = () => useContext(ActiveSessionIdContext);
export const useSessionIndex = () => useContext(SessionIndexContext);
export const useSessionActions = () => useContext(SessionActionsContext);
export const useSessionQueue = () => useContext(SessionQueueContext);
