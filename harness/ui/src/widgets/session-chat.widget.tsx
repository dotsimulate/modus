/**
 * Conversation Host — the invariant boundary between a live session and an
 * authored conversation lens. The historical `session-chat` widget key stays
 * in place so project chat-studio forks and editable panel state do not migrate.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConversationLensDefinitionV1,
  ConversationLensRegistryEntry,
  ConversationResourceRegistry,
} from "../../../sdk/index";
import { resolveConversationCapabilities, resolveConversationLens } from "../conversation-lens-resolution";
import { PageView } from "../components/PageRenderer";
import { PermissionOverlay } from "../components/PermissionOverlay";
import { QueuedMessage } from "../components/QueuedMessage";
import { useScopeBus } from "../components/pageScope";
import {
  applyInterfaceSettings,
  projectChatOverrideEnabled,
  writableProjectChatConfig,
  writeDeviceInterfaceSettings,
} from "../interface-settings";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { useActiveSessionId, useSessionQueue } from "../providers/SessionContext";
import { ensureSubscribed, useSessionHistoryLoadState, useSessionState } from "../sessionStore";
import { useConversationResources } from "../useConversationResources";
import { useInterfaceSettings } from "../useInterfaceSettings";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type SessionChatConfig = WidgetBase & {
  type: "session-chat";
  sessionId?: string;
};

const EMERGENCY_TRANSCRIPT_DEFINITION: ConversationLensDefinitionV1 = {
  contract: "conversation-lens@1",
  id: "core:transcript",
  label: "Transcript",
  description: "Built-in recovery transcript",
  capabilities: {
    required: ["conversation.permissions", "conversation.turn-content", "conversation.history"],
  },
  layout: {
    kind: "widget",
    widget: { type: "conversation-transcript", id: "emergency-transcript" },
  },
  layouts: {
    mobile: {
      kind: "widget",
      widget: { type: "conversation-transcript", id: "emergency-transcript-mobile" },
    },
  },
  context: { turnNumber: null, turnSeq: null, turnSessionId: null },
};

function emergencyRegistry(cwd: string, reason: string): ConversationResourceRegistry {
  const entry: ConversationLensRegistryEntry = {
    id: "core:transcript",
    status: "degraded",
    source: { kind: "harness", label: "Modus recovery", key: "harness:recovery" },
    reason,
    definition: EMERGENCY_TRANSCRIPT_DEFINITION,
  };
  return {
    contract: "conversation-resources@1",
    cwd,
    lenses: [entry],
    projections: [],
    diagnostics: [],
  };
}

export default function ConversationHostWidget(props: WidgetProps<SessionChatConfig>) {
  const { config, pageContext } = props;
  const parentBus = useScopeBus();
  const activeSessionId = useActiveSessionId();
  const { queuedMessage, cancelQueued } = useSessionQueue();
  const { activeUP, activeCwd, activeUserProfile, refreshUserProfiles } = useProfiles();
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const selectedSession = pageContext?.get("selectedSession") as string | undefined;
  const sessionId = contextSessionId ?? selectedSession ?? config.sessionId ?? null;

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const historyLoad = useSessionHistoryLoadState(sessionId);
  const interfaceSettings = useInterfaceSettings(activeUP?.interface);
  const cwd = session?.cwd ?? activeCwd ?? null;
  const resources = useConversationResources(cwd);
  const [runtimeFailure, setRuntimeFailure] = useState<{ lensId: string; reason: string } | null>(null);

  useEffect(() => {
    setRuntimeFailure(null);
  }, [cwd, sessionId, interfaceSettings.chat.lensId]);

  useEffect(() => {
    const onProjectionFailure = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        lensId?: string;
        reason?: string;
      }>).detail;
      if (!detail || detail.sessionId !== sessionId || !detail.lensId) return;
      setRuntimeFailure({
        lensId: detail.lensId,
        reason: detail.reason ?? "authored projection failed",
      });
    };
    window.addEventListener("modus:conversation-projection-error", onProjectionFailure);
    return () => window.removeEventListener("modus:conversation-projection-error", onProjectionFailure);
  }, [sessionId]);

  const capabilities = useMemo(() => resolveConversationCapabilities({
    sessionId,
    historyError: historyLoad.status === "error" ? historyLoad.error : historyLoad.olderError,
  }), [historyLoad.error, historyLoad.olderError, historyLoad.status, sessionId]);

  const defaultLensId = interfaceSettings.chat.lensId;
  const requestedLensId = defaultLensId;
  // Discovery has three non-ready shapes and only one of them is a lens problem.
  // `error` and `idle` both own a working transcript through the recovery
  // registry, but `loading` must stay null: resolving against an empty registry
  // reports every candidate as "not discovered for this project", which blames
  // the project for a request that has simply not answered yet.
  const registry = useMemo(() => {
    if (resources.registry) return resources.registry;
    if (resources.status === "error") {
      return emergencyRegistry(cwd ?? "", resources.error ?? "lens discovery failed");
    }
    if (resources.status === "idle") {
      return emergencyRegistry(cwd ?? "", "this session has no project directory");
    }
    return null;
  }, [cwd, resources.error, resources.registry, resources.status]);
  const ordinaryResolution = useMemo(
    () => resolveConversationLens(registry, requestedLensId, defaultLensId, capabilities),
    [capabilities, defaultLensId, registry, requestedLensId],
  );
  const activeRuntimeFailure = runtimeFailure?.lensId === ordinaryResolution.resolvedId
    ? runtimeFailure
    : null;
  const resolution = useMemo(() => {
    if (!activeRuntimeFailure) return ordinaryResolution;
    const recoveryRegistry = emergencyRegistry(cwd ?? "", activeRuntimeFailure.reason);
    const recovery = resolveConversationLens(recoveryRegistry, "core:transcript", "core:transcript", capabilities);
    return {
      ...recovery,
      requestedId: requestedLensId,
      reason: `${activeRuntimeFailure.lensId}: ${activeRuntimeFailure.reason}; using Transcript`,
    };
  }, [activeRuntimeFailure, capabilities, cwd, ordinaryResolution, requestedLensId]);

  const handlePermission = useCallback(async (
    requestId: string,
    behavior: "allow" | "deny",
    updatedInput?: Record<string, unknown>,
    scope?: "once" | "session",
  ) => {
    if (!sessionId) return;
    await modus.respondToPermission(sessionId, { requestId, behavior, updatedInput, scope }).catch(() => {});
  }, [sessionId]);

  const handleOpenTranscript = useCallback(() => {
    const next = {
      ...interfaceSettings,
      chat: { ...interfaceSettings.chat, lensId: "core:transcript" },
    };
    applyInterfaceSettings(next);

    if (projectChatOverrideEnabled(activeUP?.interface) && activeUserProfile) {
      void modus.patchUserProfileUiConfig(activeUserProfile, {
        interface: {
          chat: writableProjectChatConfig(activeUP?.interface?.chat, next),
        },
      }).then(refreshUserProfiles).catch(() => {});
      return;
    }

    writeDeviceInterfaceSettings(next);
  }, [activeUP?.interface, activeUserProfile, interfaceSettings, refreshUserProfiles]);

  if (!sessionId) return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  if (!session) return <WidgetEmptyState>loading session…</WidgetEmptyState>;
  if (!registry) return <WidgetEmptyState>loading conversation…</WidgetEmptyState>;

  const permissions = session.pendingPermissions ?? [];
  const pendingSend = activeSessionId === sessionId ? queuedMessage : null;
  const entry = resolution.entry;
  const definition = entry?.definition;
  const diagnosticEntry = activeRuntimeFailure ? ordinaryResolution.entry : entry;
  const lensDegraded = diagnosticEntry?.status === "degraded";
  const lensReason = resolution.reason
    ?? (lensDegraded
      ? (diagnosticEntry.reason ?? `${diagnosticEntry.definition?.label ?? diagnosticEntry.id} is degraded`)
      : undefined);
  const gitUnavailable = interfaceSettings.conversation.showGitEvents && !session.cwd;
  const statusReason = lensReason
    ?? (gitUnavailable ? "git events unavailable · this session has no cwd" : undefined)
    ?? (historyLoad.status === "error" ? (historyLoad.error ?? "conversation history unavailable") : undefined)
    ?? historyLoad.olderError;
  const showTranscriptRecovery = requestedLensId !== "core:transcript"
    && Boolean(activeRuntimeFailure || resolution.reason || lensDegraded);
  const diagnosticSource = diagnosticEntry
    ? `${diagnosticEntry.source.label} · ${diagnosticEntry.source.kind}`
    : null;

  return (
    <div className="conversation-host">
      {statusReason && (
        <div className="conversation-host-diagnostic" role="status">
          <span className="conversation-host-diagnostic-text">
            {diagnosticSource ? `${diagnosticSource} · ${statusReason}` : statusReason}
          </span>
          {showTranscriptRecovery && (
            <button type="button" onClick={handleOpenTranscript}>open Transcript</button>
          )}
        </div>
      )}

      {pendingSend && <QueuedMessage message={pendingSend} onCancel={cancelQueued} />}

      <div className="conversation-host-stage">
        {resources.status === "loading" && !definition ? (
          <WidgetEmptyState>discovering conversation views…</WidgetEmptyState>
        ) : definition ? (
          <PageView
            key={`${sessionId}:${resolution.resolvedId}:${entry?.source.key}`}
            layout={definition.layout as any}
            layouts={definition.layouts as any}
            context={{
              ...(definition.context ?? {}),
              sessionId,
              conversationLensId: resolution.resolvedId,
              conversationCwd: cwd,
            }}
            padding={0}
            onNavigate={props.onNavigate}
            onSelectSession={props.onSelectSession}
            pageId={`conversation-lens:${resolution.resolvedId}`}
            parentBus={parentBus}
            bindings={[
              { local: "sessionId", parent: "sessionId", direction: "down" },
              { local: "turnNumber", parent: "turnNumber", direction: "twoWay" },
              { local: "turnSeq", parent: "turnSeq", direction: "twoWay" },
              { local: "turnSessionId", parent: "turnSessionId", direction: "twoWay" },
            ]}
          />
        ) : (
          <WidgetEmptyState>{resolution.reason ?? "Transcript unavailable"}</WidgetEmptyState>
        )}
      </div>

      {permissions.length > 0 && (
        <PermissionOverlay
          permissions={permissions}
          sessionId={sessionId}
          onRespond={handlePermission}
        />
      )}
    </div>
  );
}
