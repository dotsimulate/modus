/**
 * Provider Interface — the contract any execution backend must satisfy.
 *
 * Session-manager handles lifecycle (create, persist, broadcast, subscribe).
 * Providers handle execution (run a turn, send follow-ups, abort).
 */

import type { ActiveSession, StartSessionOpts, MessageContent } from "../session-manager";
import type { Profile } from "../profiles";

// ── Provider Interface ──

export type ProviderToolGroup = {
  label: string;
  tools: string[];
};

export type ProviderSlashCommand = {
  command: string;
  label: string;
  description?: string;
  argumentHint?: string;
  requiresArgument?: boolean;
  source?: "provider" | "modus";
};

export type ProviderCapabilities = {
  name: string;
  label: string;
  family: "antigravity" | "claude-code" | "codex" | "cursor" | "gemini-cli" | "grok-build" | "opencode" | "pi-agent";
  builtInTools: string[];
  builtInToolGroups: ProviderToolGroup[];
  builtInToolMode: "explicit" | "event-derived";
  slashCommands?: ProviderSlashCommand[];
  supportsMcp: boolean;
  mcpSupport: "full" | "stdio-only" | "none";
  /** Whether the provider discovers skills on disk by itself. Derived centrally
   *  in `registry.ts` from `provider-names.ts`, not declared per provider. */
  readsNativeSkills?: boolean;
  /** Where a message sent during a running turn actually lands. `"steer"` means
   *  the provider injects it at the next tool boundary; `"next-turn"` means it
   *  can only be queued until the turn ends. Derived centrally in `registry.ts`
   *  from `provider-names.ts` so clients can say which will happen before
   *  sending. */
  messageDelivery?: "steer" | "next-turn";
  nonToolSignals: string[];
  permissionModel: {
    mode: "per-tool-ui" | "runtime-native" | "none";
    interactive: boolean;
    summary: string;
  };
  sessionMutability: {
    providerSwitchAfterStart: boolean;
    profileSwitch: "allowed" | "provider-locked";
    configApplies: "immediate" | "next-turn";
  };
};

export interface SessionProvider {
  /** Static capability description used by API/UI to describe actual provider behavior. */
  capabilities: ProviderCapabilities;

  /** Kick off the first turn. Runs async, calls ctx helpers to emit events. */
  startTurn(ctx: TurnContext): void;

  /** Send a follow-up message to an idle or running session */
  sendMessage(ctx: TurnContext, content: MessageContent): void;

  /** Abort the current turn */
  abort(session: ActiveSession): void;

  /** Stop a specific sub-task (optional — only Claude SDK supports this) */
  stopTask?(session: ActiveSession, taskId: string): boolean;

  /**
   * Inject a message mid-turn at the next tool boundary (steer mode).
   * Returns true if the message was injected into the running turn.
   * Returns false if not supported — caller falls back to queue.
   * Only implement if the provider can genuinely deliver mid-run.
   */
  steerMessage?(ctx: TurnContext, content: MessageContent): boolean;

  /** Update mutable config mid-session (optional — only Claude SDK needs this) */
  updateConfig?(session: ActiveSession, config: Record<string, any>): void;

  /** Switch active profile mid-session (optional — provider-specific swap logic) */
  switchProfile?(session: ActiveSession, ctx: TurnContext, contextMode: string): void;

  /** Provider-native file rewind. Absence means Modus must not claim native support. */
  previewWorkspaceRewind?(session: ActiveSession, providerMessageId: string): Promise<{
    available: boolean;
    files: string[];
    insertions?: number;
    deletions?: number;
    error?: string;
  }>;
  applyWorkspaceRewind?(session: ActiveSession, providerMessageId: string): Promise<{
    ok: boolean;
    files: string[];
    insertions?: number;
    deletions?: number;
    error?: string;
  }>;

  /** Clean up provider-specific resources when a session is fully done.
   *  Called by session-manager on shutdown and cross-provider switch. */
  dispose?(session: ActiveSession): Promise<void>;
}

// ── Turn Context ──
// Passed to providers so they can interact with session-manager's shared infrastructure
// without importing it directly (avoids circular deps).

export type TurnContext = {
  session: ActiveSession;
  opts: StartSessionOpts;
  profile: Profile | undefined;

  /** Persist event to DB + broadcast to SSE subscribers */
  emitEvent(event: any): void;

  /** Broadcast to SSE subscribers only (no DB persist) */
  broadcastEvent(event: any): void;

  /** Re-key the session in the active sessions map (called when SDK provides real ID) */
  rekeySession(newId: string): void;

  /** Persist the provider's native conversation/thread ID independently of the Modus row ID. */
  setProviderSessionId(providerSessionId: string): void;

  /** Notify session-manager of a provider-initiated config change.
   *  Updates _configOverrides and emits config_updated to subscribers. */
  notifyConfigChange(patch: Record<string, unknown>): void;

  /** Update session row in the DB */
  updateSessionDb(updates: {
    status?: string;
    messageCount?: number;
    costUsd?: number;
    lastPrompt?: string;
    lastResponse?: string;
    provider?: string;
  }): void;
};
