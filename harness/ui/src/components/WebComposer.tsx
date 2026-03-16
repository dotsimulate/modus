/**
 * WebComposer — floating ConfigBar + ChatInput for the SessionWeb canvas.
 *
 * Appears on double-click of empty canvas. User configures profile/model,
 * types a prompt, and sends. On send, a session is created and the
 * sessionId is returned via onSessionCreated.
 *
 * Uses useSessionComposer for all profile resolution and session creation.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import { ConfigBar } from "./ConfigBar";
import { ChatInput } from "./ChatInput";
import { useSessionComposer } from "../hooks/useSessionComposer";
import type { Attachment } from "../api";

type Props = {
  /** Screen position to anchor the panel */
  x: number;
  y: number;
  /** Called when a session is created (after first message sent) */
  onSessionCreated: (sessionId: string) => void;
  onClose: () => void;
};

export function WebComposer({ x, y, onSessionCreated, onClose }: Props) {
  const composer = useSessionComposer(null, null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSend = useCallback(async (attachments: Attachment[], textOverride?: string) => {
    const prompt = (textOverride ?? input).trim();
    if (!prompt && attachments.length === 0) return;
    if (sending) return;

    setSending(true);
    try {
      const { sessionId } = await composer.createAndSend(prompt, {
        profile: composer.activeProfileName,
        attachments: attachments.length > 0 ? attachments.map(a => ({
          type: a.type,
          mediaType: a.mediaType,
          data: a.data,
          name: a.name,
        })) : undefined,
      });
      onSessionCreated(sessionId);
    } catch (err) {
      console.error("WebComposer: failed to create session:", err);
      setSending(false);
    }
  }, [input, sending, composer, onSessionCreated]);

  const handleStop = useCallback(() => {
    // No-op in pre-session mode
  }, []);

  // Clamp position so the panel doesn't overflow the viewport
  const panelWidth = 420;
  const panelX = Math.min(x, window.innerWidth - panelWidth - 16);
  const panelY = Math.min(y, window.innerHeight - 280);

  return (
    <div
      ref={panelRef}
      className="web-composer"
      style={{ left: panelX, top: panelY }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      <ConfigBar
        profileName={composer.activeProfileName}
        model={composer.liveModel}
        agentConfig={composer.agentConfig}
        editorConfig={composer.editorAgentConfig}
        onAgentConfigChange={composer.setAgentConfig}
        profileTools={composer.profileData?.tools ?? "all"}
        editorProfileTools={composer.editorProfileData?.tools ?? "all"}
        availableProviders={composer.availableProviders}
        profileProvider={composer.liveProvider}
        editorProfileProvider={composer.editorProfileProvider}
        editorProfileModel={composer.editorProfileModel}
        profileEffort={composer.profileEffort}
        editorProfileEffort={composer.editorProfileEffort}
        editorProfileMaxTurns={composer.editorProfileMaxTurns}
        showProvider={true}
        profiles={composer.visibleProfiles}
        onSwitchProfile={composer.selectProfile}
        status={null}
      />
      <ChatInput
        value={input}
        onChange={setInput}
        onSend={handleSend}
        onStop={handleStop}
        sessionStatus={sending ? "running" : null}
        disabled={sending}
        placeholder="start a conversation..."
        projectCwd={composer.projectCwd}
        userProfile={composer.userProfile}
        autoFocus
      />
    </div>
  );
}
