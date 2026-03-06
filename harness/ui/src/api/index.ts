// Barrel re-export — all consumers can keep importing from "./api" or "../api"

// Shared internals (token management)
export { setAuthToken, clearAuthToken } from "./_fetch";

// Auth
export { authStatus, setupNewPin, verifyPin, fetchMe, lockAll, checkToken, healthCheck } from "./auth";

// Profiles
export {
  fetchProfiles, fetchProfile, saveProfileApi, deleteProfileApi,
  fetchGlobalConfig, saveGlobalConfigApi, checkSecrets,
  fetchProviders, fetchProviderModels,
  fetchUserProfiles, fetchUserProfile, saveUserProfileApi, patchUserProfileApi,
  fetchUserProfileState, patchUserProfileStateApi,
} from "./profiles";

// Sessions
export {
  fetchSessions, fetchSessionStatus, fetchActiveSessions,
  searchSessions, archiveSessionApi,
  getDraft, saveDraft, createEmptySession,
  createSession, sendMessage, stopSessionApi, updateSessionConfig,
  respondToPermission,
  fetchSessionsScoped, searchSessionsScoped,
  browsePath, subscribeEvents,
} from "./sessions";

// Actions
export { fetchActions, fetchActionRuns, triggerActionApi, updateActionApi, fetchActionInfo, clearActionRunsApi, resetActionApi, fetchActionPreferences } from "./actions";

// Git
export { fetchGitStatus, fetchGitLog, fetchGitShow, fetchGitFileDiff, fetchGitFileContent, fetchGitReadme, openInEditor } from "./git";

// Memories
export { fetchMemories } from "./memories";

// All types
export type {
  ToolCall, SubTask, Attachment, Message, PendingPermission, SessionStatus, Session,
  McpServerConfig, ProfileUi, Profile, GlobalConfig,
  SessionInfo, ActiveSessionInfo, SearchHit, SessionStatusInfo,
  ApiAttachment, CreateSessionOpts, BrowseResult, PermissionResponse,
  UserProfileState, UserProfile, MemoryItem,
  ActionTrigger, ActionInfo, ActionRun,
  GitStatus, GitCommit, DiffLine, DiffHunk, FileDiff, GitCommitDetail,
  EventStreamCallbacks,
} from "./types";

export type { ProviderModel } from "./profiles";

// Utility
export { nextMsgId } from "./types";
