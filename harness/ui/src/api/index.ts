// Barrel re-export — all consumers can keep importing from "./api" or "../api"

// Shared internals (token management)
export { setAuthToken, clearAuthToken } from "./_fetch";

// Auth
export { authStatus, setupNewPin, verifyPin, fetchMe, lockAll, checkToken, changePinApi, healthCheck } from "./auth";

// Profiles
export {
  fetchProfiles, fetchProfile, saveProfileApi, deleteProfileApi,
  fetchGlobalConfig, saveGlobalConfigApi, checkSecrets,
  fetchProviders, fetchProviderCapabilities, fetchProviderModels,
  fetchUserProfiles, fetchUserProfile, saveUserProfileApi, patchUserProfileApi,
  fetchUserProfileState, patchUserProfileStateApi,
} from "./profiles";

// Sessions
export {
  fetchSessions, fetchSessionStatus, fetchActiveSessions,
  searchSessions, archiveSessionApi, updateSessionTitle,
  getDraft, saveDraft, createEmptySession,
  createSession, sendMessage, stopSessionApi, stopTaskApi, switchSessionProfile,
  updateSessionConfig, respondToPermission,
  fetchSessionsScoped, fetchSessionsByProfile, searchSessionsScoped,
  fetchSessionStats, fetchAccountInfo, browsePath, readFileContent, subscribeEvents, branchSessionApi,
  fetchGeminiUsage,
} from "./sessions";

export type { SessionStats, AccountInfo, GeminiUsageInfo } from "./sessions";

// Actions
export { fetchActions, fetchActionRuns, triggerActionApi, updateActionApi, fetchActionInfo, clearActionRunsApi, resetActionApi, fetchActionPreferences, reloadActionsApi, addTagApi, removeTagApi } from "./actions";

// Git
export { fetchGitStatus, fetchGitLog, fetchGitShow, fetchGitFileDiff, fetchGitFileContent, fetchGitReadme, openInEditor } from "./git";

// Projects & Init
export { fetchInitStatus, initProject, fetchProjects } from "./projects";

// Memories
export { fetchMemories } from "./memories";

// Prompts
export { fetchPrompts, renderPromptApi, reloadPromptsApi } from "./prompts";
export type { PromptListItem, PromptInput, RenderResult } from "./prompts";

// All types
export type {
  ToolCall, SubTask, Attachment, Message, PendingPermission, SessionStatus, Session, AgentConfigState,
  McpServerConfig, ProfileUi, Profile, GlobalConfig,
  ProviderCapabilities, ProviderToolGroup,
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
