/**
 * Config Bar widget — session config/profile bar as a page-embeddable widget.
 *
 * Config: { "type": "config-bar", "id": "cb-1", "sessionId": "optional-id" }
 *
 * Subscribes to `sessionId` from pageContext (or config). Reads profile and
 * session state to populate ConfigBar props. Allows profile switching and
 * agent config changes on the active session.
 */

import { useEffect, useCallback, useMemo } from "react";
import { useSessionState, subscribeSession, isSubscribed } from "../sessionStore";
import { useSession } from "../providers/SessionContext";
import { useProfiles } from "../providers/ProfileContext";
import { ConfigBar } from "../components/ConfigBar";
import { createEmptyAgentConfig } from "../components/AgentConfig";
import { modus } from "../modusClient";
import type { WidgetBase, WidgetProps } from "./types";
import { WidgetEmptyState } from "./widget-components";

type ConfigBarConfig = WidgetBase & {
  type: "config-bar";
  sessionId?: string;
  /** Keep panel expanded even on outside clicks */
  persistOpen?: boolean;
};

export default function ConfigBarWidget({ config, pageContext }: WidgetProps<ConfigBarConfig>) {
  const contextSessionId = pageContext?.get("sessionId") as string | undefined;
  const sessionId = contextSessionId ?? config.sessionId ?? null;

  useEffect(() => {
    if (sessionId && !isSubscribed(sessionId)) {
      subscribeSession(sessionId, 0);
    }
  }, [sessionId]);

  const session = useSessionState(sessionId);
  const { updateActiveSessionConfig, updateActiveSessionProfile, serverSessions, refreshSessions } = useSession();
  const { profiles, visibleProfiles, availableProviders, activeUP } = useProfiles();

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

  if (!sessionId) {
    return <WidgetEmptyState>no session selected</WidgetEmptyState>;
  }

  return (
    <div className="config-bar-widget" style={{ width: "100%" }}>
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
    </div>
  );
}
