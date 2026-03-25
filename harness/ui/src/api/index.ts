// Barrel re-export — all consumers can keep importing from "./api" or "../api"

// Shared internals (token management)
export { setAuthToken, clearAuthToken } from "./_fetch";

// Auth
export { authStatus, setupNewPin, verifyPin, fetchMe, lockAll, checkToken, changePinApi, healthCheck } from "./auth";

// Profiles
export {
  fetchProfiles, fetchProfile, fetchProfileUiConfig, saveProfileApi, patchProfileUiConfigApi, deleteProfileApi,
  fetchGlobalConfig, saveGlobalConfigApi, checkSecrets,
  fetchProviders, fetchProviderCapabilities, fetchProviderHealth, fetchProviderModels,
  fetchUserProfiles, fetchUserProfile, fetchUserProfileUiConfig, saveUserProfileApi, patchUserProfileApi, patchUserProfileUiConfigApi,
  fetchUserProfileState, patchUserProfileStateApi,
} from "./profiles";

// Sessions
export {
  fetchSessions, fetchSessionStatus, fetchActiveSessions,
  searchSessions, archiveSessionApi, unarchiveSessionApi, fetchArchivedSessions, updateSessionTitle,
  addSessionTagApi, removeSessionTagApi,
  getDraft, saveDraft, createEmptySession,
  createSession, sendMessage, stopSessionApi, stopTaskApi, switchSessionProfile,
  updateSessionConfig, respondToPermission,
  fetchSessionUiState, saveSessionUiState,
  fetchSessionsScoped, fetchSessionsByProfile, searchSessionsScoped,
  fetchSessionStats, fetchAccountInfo, browsePath, readFileContent, writeFileContent, subscribeEvents, branchSessionApi,
  fetchGeminiUsage, fetchMessageContent,
  createFile, createDirectory,
} from "./sessions";

export type { SessionStats, AccountInfo, GeminiUsageInfo, TurnContent, MoveBinding } from "./sessions";

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
export { fetchClientExtensions, patchClientExtension } from "./client-extensions";

// Memories
export { fetchMemories } from "./memories";

// Prompts
export { fetchPrompts, renderPromptApi, reloadPromptsApi } from "./prompts";
export type { PromptListItem, PromptInput, RenderResult } from "./prompts";

// Moves
export { fetchMoves, activateMoveApi, activateProjectMoveApi, callMoveOp, fetchActiveWidget, rekeyMoveSession, rekeyMoveByTokenApi, fetchAmbientMoves, deactivateAmbientMoveApi, attachMoveApi, activateAttachedMoveApi, detachMoveApi } from "./moves";
export type { MoveInput, MoveListItem, MovePageInfo, ActivateMoveResult, MoveWidgetInfo, AmbientMoveInfo, AttachMoveResult } from "./moves";

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
export { fetchProviderUsageAnalytics, fetchDeepAnalytics } from "./analytics";
export type {
  ProviderUsageAnalytics, ProviderUsageDaily, ProviderUsageTotal, ModelUsageTotal, UsageBucket,
  DeepAnalytics, DeepAnalyticsBucket, DeepAnalyticsMetricRow, DeepAnalyticsHourRow, DeepAnalyticsSessionRow,
} from "./analytics";

// All types
export type {
  ToolCall, SubTask, Attachment, SessionArtifact, Message, PendingPermission, SessionStatus, Session, AgentConfigState,
  McpServerConfig, ProfileUi, Profile, GlobalConfig,
  ProviderCapabilities, ProviderToolGroup, ProviderHealthInfo, ProviderHealthCheck,
  SessionInfo, ActiveSessionInfo, SearchHit, SessionStatusInfo, CommitAttribution, CommitAttributionReason,
  ApiAttachment, CreateSessionOpts, BrowseResult, PermissionResponse,
  UserProfileState, UserProfile, UserProfileUiConfig, ProjectUiAssetInfo, ActiveProjectUiAsset, ProjectUiState, MemoryItem,
  ClientExtensionManifestItem, ExtensionSettingSchema, ExtensionMeta,
  ActionTrigger, ActionInfo, ActionRun,
  GitStatus, GitCommit, DiffLine, DiffHunk, FileDiff, GitCommitDetail,
  EventStreamCallbacks,
} from "./types";

export type { ProviderModel } from "./profiles";

// Filesystem events
export { onFsChange, setFsWatchRoot, disconnectFsEvents } from "./fs-events";
export type { FsChangeEvent } from "./fs-events";

// Utility
export { nextMsgId } from "./types";
