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
  addSessionTagApi, removeSessionTagApi,
  getDraft, saveDraft, createEmptySession,
  createSession, sendMessage, stopSessionApi, stopTaskApi, switchSessionProfile,
  updateSessionConfig, respondToPermission,
  fetchSessionsScoped, fetchSessionsByProfile, searchSessionsScoped,
  fetchSessionStats, fetchAccountInfo, browsePath, readFileContent, subscribeEvents, branchSessionApi,
  fetchGeminiUsage, fetchMessageContent,
} from "./sessions";

export type { SessionStats, AccountInfo, GeminiUsageInfo, TurnContent } from "./sessions";

// Actions
export { fetchActions, fetchActionRuns, triggerActionApi, updateActionApi, fetchActionInfo, clearActionRunsApi, resetActionApi, fetchActionPreferences, reloadActionsApi, addTagApi, removeTagApi } from "./actions";

// Git
export { fetchGitStatus, fetchGitLog, fetchGitShow, fetchGitFileDiff, fetchGitFileContent, fetchGitReadme, openInEditor } from "./git";

// Projects & Init
export { fetchInitStatus, initProject, fetchProjects } from "./projects";

// Project UI
export {
  fetchProjectUiState, fetchProjectThemes, fetchProjectFonts,
  activateProjectThemeApi, activateProjectFontApi,
} from "./ui";

// Client extensions
export { fetchClientExtensions } from "./client-extensions";

// Memories
export { fetchMemories } from "./memories";

// Prompts
export { fetchPrompts, renderPromptApi, reloadPromptsApi } from "./prompts";
export type { PromptListItem, PromptInput, RenderResult } from "./prompts";

// Moves
export { fetchMoves, activateMoveApi, activateProjectMoveApi } from "./moves";
export type { MoveInput, MoveListItem, ActivateMoveResult } from "./moves";

// Missions
export {
  fetchMissions, fetchMissionRuns, fetchMissionRunDetail,
  fetchMissionTransfers, fetchMissionSessions,
  fetchMissionSteps, fetchMissionGates,
  startMissionApi, pauseMissionApi, resumeMissionApi,
} from "./missions";
export type {
  MissionListItem, MissionRunSummary, MissionStepRunSummary,
  MissionTransferSummary, MissionGateResultSummary,
  MissionRunStatus, MissionTransferKind,
} from "./missions";

// Analytics
export { fetchProviderUsageAnalytics } from "./analytics";
export type { ProviderUsageAnalytics, ProviderUsageDaily, ProviderUsageTotal, ModelUsageTotal, UsageBucket } from "./analytics";

// All types
export type {
  ToolCall, SubTask, Attachment, SessionArtifact, Message, PendingPermission, SessionStatus, Session, AgentConfigState,
  McpServerConfig, ProfileUi, Profile, GlobalConfig,
  ProviderCapabilities, ProviderToolGroup,
  SessionInfo, ActiveSessionInfo, SearchHit, SessionStatusInfo, CommitAttribution, CommitAttributionReason,
  ApiAttachment, CreateSessionOpts, BrowseResult, PermissionResponse,
  UserProfileState, UserProfile, ProjectUiAssetInfo, ActiveProjectUiAsset, ProjectUiState, MemoryItem,
  ClientExtensionManifestItem,
  ActionTrigger, ActionInfo, ActionRun,
  GitStatus, GitCommit, DiffLine, DiffHunk, FileDiff, GitCommitDetail,
  EventStreamCallbacks,
} from "./types";

export type { ProviderModel } from "./profiles";

// Utility
export { nextMsgId } from "./types";
