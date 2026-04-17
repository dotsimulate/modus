/**
 * Composer widget — config bar + chat input as a single page-embeddable widget.
 *
 * Config: { "type": "composer", "id": "comp-1", "sessionId": "optional-id" }
 *
 * Subscribes to `sessionId` from pageContext (or config). Renders the session
 * ConfigBar above ChatInput so a single widget covers the full compose area.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useSessionState, ensureSubscribed, getSessionState, setSessionState } from "../sessionStore";
import { useInputValue, setInputValue } from "../inputStore";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { modus } from "../modusClient";
import { ChatInput } from "../components/ChatInput";
import { ConfigBar } from "../components/ConfigBar";
import { createEmptyAgentConfig } from "../components/AgentConfig";
import { nextMsgId } from "../../../sdk/index";
import type { Attachment, MoveBinding } from "../../../sdk/index";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type ComposerConfig = WidgetBase & {
  type: "composer";
  sessionId?: string;
  placeholder?: string;
  /** Keep config bar panel expanded even on outside clicks */
  persistOpen?: boolean;
};

export default function ComposerWidget({ config, pageContext }: WidgetProps<ComposerConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = contextSessionId ?? config.sessionId ?? null;

  useEffect(() => {
    if (sessionId) void ensureSubscribed(sessionId);
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const { updateActiveSessionConfig, updateActiveSessionProfile, serverSessions, refreshSessions } = useSession();
  const { projectRoot, activeUserProfile, profiles, visibleProfiles, availableProviders, activeUP } = useProfiles();

  const input = useInputValue();
  const projectCwd = session?.cwd ?? projectRoot;

  // ── Config bar state ──

  const sessionInfo = useMemo(
    () => sessionId ? serverSessions.find((s) => s.id === sessionId) : undefined,
    [sessionId, serverSessions],
  );

  const profileName = session?.profile || activeUP?.defaultAgentProfile || visibleProfiles[0]?.name || "";
  const profileData = profiles.find((p) => p.name === profileName);
  const editorProfileName = session?.nextProfile ?? profileName;
  const editorProfileData = profiles.find((p) => p.name === editorProfileName);
  const liveProvider = sessionInfo?.provider || session?.provider || profileData?.provider || activeUP?.provider;
  const liveModel = session?.model || profileData?.model || activeUP?.model || "";
  const sessionProviderLocked = !!session && (session.messages?.length ?? 0) > 0;
  const editorProfileProvider = editorProfileData?.provider ?? activeUP?.provider;
  const editorProfileModel = editorProfileData?.model ?? activeUP?.model;
  const pendingProfileProviderMatches = !sessionProviderLocked
    || !liveProvider
    || !editorProfileProvider
    || editorProfileProvider === liveProvider;

  const agentConfig = session?.agentConfig ?? createEmptyAgentConfig();
  const editorAgentConfig = session?.nextAgentConfig
    ?? (session?.nextProfile && session.nextProfile !== session.profile
      ? createEmptyAgentConfig()
      : agentConfig);

  const sessionTags = useMemo(() => {
    const raw = sessionInfo?.tags;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
    } catch { return []; }
  }, [sessionInfo?.tags]);

  const handleSwitchProfile = useCallback((name: string) => {
    if (sessionId && !sessionId.startsWith("pending-")) {
      updateActiveSessionProfile(name);
    }
  }, [sessionId, updateActiveSessionProfile]);

  const handleTogglePin = useCallback(async () => {
    if (!sessionId) return;
    if (sessionTags.includes("pinned")) {
      await modus.removeTag(sessionId, "pinned").catch(() => {});
    } else {
      await modus.addTag(sessionId, "pinned").catch(() => {});
    }
    refreshSessions();
  }, [sessionId, sessionTags, refreshSessions]);

  // ── Send / stop ──

  const handleSend = useCallback(
    (attachments: Attachment[], textOverride?: string, moves?: MoveBinding[]) => {
      if (!sessionId) return;
      const prompt = (textOverride ?? input).trim();
      if (!prompt && attachments.length === 0) return;

      setInputValue("");

      const sendAttachments = attachments.length > 0 ? attachments : undefined;
      const apiAtts = attachments.length > 0
        ? attachments.map((a) => ({ type: a.type, mediaType: a.mediaType, data: a.data, name: a.name }))
        : undefined;

      // Optimistically insert the user message so it appears immediately
      const current = getSessionState(sessionId);
      if (current) {
        setSessionState(sessionId, {
          ...current,
          messages: [
            ...current.messages,
            {
              id: nextMsgId(),
              role: "user" as const,
              content: prompt,
              timestamp: Date.now(),
              attachments: sendAttachments,
            },
          ],
        });
      }

      modus.sendMessage(sessionId, {
        prompt,
        moves: moves ?? undefined,
        attachments: apiAtts,
      } as any).then(() => {
        // Re-subscribe to SSE after the backend has accepted the message.
        // Must happen AFTER sendMessage resolves — otherwise the SSE endpoint
        // sees an idle session, immediately closes, and the subscription is
        // gone before the agent starts emitting events.
        void ensureSubscribed(sessionId, { activeStatus: "running" });
      }).catch((err) => {
        console.error("[composer-widget] sendMessage failed:", err);
      });
    },
    [sessionId, input],
  );

  const handleStop = useCallback(() => {
    if (!sessionId) return;
    modus.stopSession(sessionId).catch((err) => {
      console.error("[composer-widget] stopSession failed:", err);
    });
  }, [sessionId]);

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  return (
    <div className="composer-widget" style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", height: "100%", minHeight: 0 }}>
      <ConfigBar
        profileName={profileName}
        pendingProfileName={session?.nextProfile}
        model={liveModel}
        agentConfig={agentConfig}
        editorConfig={editorAgentConfig}
        onAgentConfigChange={updateActiveSessionConfig}
        profileTools={profileData?.tools ?? "all"}
        editorProfileTools={
          sessionProviderLocked && !pendingProfileProviderMatches
            ? (profileData?.tools ?? "all")
            : (editorProfileData?.tools ?? "all")
        }
        availableProviders={availableProviders}
        profileProvider={liveProvider}
        editorProfileProvider={
          sessionProviderLocked ? liveProvider : editorProfileProvider
        }
        editorProfileModel={
          pendingProfileProviderMatches ? editorProfileModel : undefined
        }
        profileEffort={session ? (profileData?.effort ?? activeUP?.effort) : (activeUP?.effort ?? profileData?.effort)}
        editorProfileEffort={session ? (editorProfileData?.effort ?? activeUP?.effort) : (activeUP?.effort ?? editorProfileData?.effort)}
        editorProfileMaxTurns={editorProfileData?.maxTurns}
        showProvider={!!session && !sessionProviderLocked}
        availableTools={session?.availableTools}
        profiles={visibleProfiles}
        onSwitchProfile={handleSwitchProfile}
        sessionTags={sessionTags}
        onTogglePin={sessionId && !sessionId.startsWith("pending-") ? handleTogglePin : undefined}
        status={session?.status}
        sessionId={sessionId}
        messages={session?.messages}
        createdAt={session?.createdAt}
        updatedAt={session?.updatedAt}
        totalCost={session?.totalCost}
        cwd={session?.cwd}
        persistOpen={config.persistOpen}
      />
      <ChatInput
        value={input}
        onChange={setInputValue}
        onSend={handleSend}
        onStop={handleStop}
        sessionStatus={session?.status ?? null}
        disabled={!session}
        placeholder={config.placeholder ?? "message..."}
        sessionId={sessionId}
        projectCwd={projectCwd}
        userProfile={activeUserProfile ?? undefined}
        autoFocus={!!sessionId}
      />
    </div>
  );
}
