import { useState, useRef, useEffect, useCallback } from "react";
import {
  AgentConfig,
  countAgentConfigDifferences,
  createEmptyAgentConfig,
  type AgentConfigState,
} from "./AgentConfig";
import { SearchDropdown } from "./SearchDropdown";
import { profileOptions } from "../profile-options";
import { ChatSettings } from "./ChatSettings";
import { getAllTools, getToolGroups, isAntigravityProvider, isClaudeCodeProvider, isCodexProvider, isGeminiProvider, isGrokBuildProvider, isToolEnabled } from "../tools";
import { useProfiles } from "../providers/ProfileContext";
import type { Profile, SessionStatus, Message } from "../../../sdk/index";
import { modus } from "../modusClient";
import { buildSessionLink } from "../sessionLink";
import { isTauriRuntime } from "../desktopBridge";

type Props = {
  profileName?: string;
  pendingProfileName?: string;
  model?: string;
  agentConfig: AgentConfigState;
  editorConfig: AgentConfigState;
  onAgentConfigChange: (config: AgentConfigState) => void;
  profileTools: string[] | "all";
  editorProfileTools: string[] | "all";
  availableProviders?: string[];
  profileProvider?: string;
  editorProfileProvider?: string;
  editorProfileModel?: string;
  profileEffort?: string;
  editorProfileEffort?: string;
  editorProfileMaxTurns?: number;
  showProvider?: boolean;
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
  /** Available profiles for live switching */
  profiles?: Profile[];
  /** Called when user switches profile on the live session */
  onSwitchProfile?: (name: string) => void;
  /** Current session status */
  status?: SessionStatus | null;
  /** Session metadata for copy button */
  sessionId?: string;
  messages?: Message[];
  createdAt?: number;
  updatedAt?: number;
  totalCost?: number;
  cwd?: string;
  /** When true, don't close the expanded panel on outside clicks */
  persistOpen?: boolean;
  sessionTags?: string[];
  onTogglePin?: () => void;
};

function shortModel(model?: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "");
}

function summarizeGeminiTools(
  toolStates: AgentConfigState["toolStates"],
  profileTools: string[] | "all",
  availableTools?: string[],
): string {
  const runtimeTools = new Set(
    (availableTools ?? []).filter((tool) => getAllTools("gemini-cli").includes(tool)),
  );

  if (runtimeTools.size === 0) return "Gemini tools";

  const labels = getToolGroups("gemini-cli")
    .filter((group) =>
      group.tools.some((tool) =>
        runtimeTools.has(tool) && isToolEnabled(tool, toolStates[tool] ?? "inherit", profileTools),
      ),
    )
    .map((group) => group.label);

  return labels.length > 0 ? labels.join("/") : "Gemini tools";
}

function summarizeAntigravityTools(
  toolStates: AgentConfigState["toolStates"],
  profileTools: string[] | "all",
  availableTools?: string[],
): string {
  const runtimeTools = new Set((availableTools ?? []).filter((tool) => getAllTools("antigravity").includes(tool)));
  if (runtimeTools.size === 0) return "Antigravity tools";
  const labels = getToolGroups("antigravity")
    .filter((group) => group.tools.some((tool) => runtimeTools.has(tool) && isToolEnabled(tool, toolStates[tool] ?? "inherit", profileTools)))
    .map((group) => group.label);
  return labels.length > 0 ? labels.join("/") : "Antigravity tools";
}

export function ConfigBar({
  profileName,
  pendingProfileName,
  model,
  agentConfig,
  editorConfig,
  onAgentConfigChange,
  profileTools,
  editorProfileTools,
  availableProviders,
  profileProvider,
  editorProfileProvider,
  editorProfileModel,
  profileEffort,
  editorProfileEffort,
  editorProfileMaxTurns,
  showProvider = false,
  availableTools,
  profiles,
  onSwitchProfile,
  status,
  sessionId,
  messages,
  createdAt,
  updatedAt,
  totalCost,
  cwd,
  persistOpen,
  sessionTags,
  onTogglePin,
}: Props) {
  const isPinned = sessionTags?.includes("pinned") ?? false;
  const { providerCapabilities, activeUserProfile } = useProfiles();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  const copySessionLink = useCallback(async () => {
    if (!sessionId) return;
    await navigator.clipboard.writeText(buildSessionLink({
      sessionId,
      project: activeUserProfile,
      desktop: isTauriRuntime(),
      base: `${window.location.origin}${window.location.pathname}`,
    }));
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }, [sessionId, activeUserProfile]);

  const copySessionMetadata = useCallback(async () => {
    if (!sessionId) return;

    // Extract files touched from tool calls in messages
    const filesRead = new Set<string>();
    const filesWritten = new Set<string>();
    for (const msg of (messages ?? [])) {
      for (const tc of (msg.toolCalls ?? [])) {
        const path = (tc.input?.file_path ?? tc.input?.path ?? tc.input?.filePath) as string | undefined;
        if (!path) continue;
        if (tc.name === "Read" || tc.name === "Grep" || tc.name === "Glob") {
          filesRead.add(path);
        } else if (tc.name === "Write" || tc.name === "Edit") {
          filesWritten.add(path);
        }
      }
    }

    // Fetch touch data for this session
    let touchFiles: string[] = [];
    try {
      const res = await modus.fetchTouches({ sessionId, limit: 200 });
      touchFiles = [...new Set(res.touches.map(t => t.filePath))];
    } catch { /* ignore */ }

    const fmtTime = (ts?: number) => ts ? new Date(ts).toISOString() : "unknown";
    const msgCount = (messages ?? []).length;
    const userMsgs = (messages ?? []).filter(m => m.role === "user").length;
    const assistantMsgs = (messages ?? []).filter(m => m.role === "assistant").length;

    const lines = [
      `# Session Metadata`,
      ``,
      `- **Session ID:** \`${sessionId}\``,
      `- **Profile:** ${profileName ?? "none"}`,
      `- **Provider:** ${agentConfig.provider || profileProvider || "unknown"}`,
      `- **Model:** ${model || "unknown"}`,
      `- **CWD:** ${cwd || "unknown"}`,
      `- **Status:** ${status || "unknown"}`,
      `- **Started:** ${fmtTime(createdAt)}`,
      `- **Last activity:** ${fmtTime(updatedAt)}`,
      `- **Cost:** $${(totalCost ?? 0).toFixed(4)}`,
      `- **Messages:** ${msgCount} total (${userMsgs} user, ${assistantMsgs} assistant)`,
    ];

    if (filesWritten.size > 0) {
      lines.push(``, `## Files Written`);
      for (const f of filesWritten) lines.push(`- \`${f}\``);
    }
    if (filesRead.size > 0) {
      lines.push(``, `## Files Read`);
      for (const f of filesRead) lines.push(`- \`${f}\``);
    }
    if (touchFiles.length > 0) {
      lines.push(``, `## All Touched Files (from trace)`);
      for (const f of touchFiles) lines.push(`- \`${f}\``);
    }

    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [sessionId, messages, profileName, agentConfig.provider, profileProvider, model, cwd, status, createdAt, updatedAt, totalCost]);

  // Close on outside click (skipped when persistOpen is set)
  useEffect(() => {
    if (!open || persistOpen) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, persistOpen]);

  const effectiveProvider = agentConfig.provider || profileProvider;
  const mcpCount = (availableTools ?? []).filter(t => t.startsWith("mcp__")).length;
  // Prefer the backend's reported built-in count so the summary matches what the
  // provider actually exposes; fall back to the static catalog.
  const builtinCount = providerCapabilities[effectiveProvider ?? ""]?.builtInTools?.length
    ?? getAllTools(effectiveProvider).length;
  const toolCount =
    (profileTools === "all" ? builtinCount : profileTools.length) + mcpCount;
  const codexControls = agentConfig.providerControls?.codex ?? {};
  const antigravityControls = agentConfig.providerControls?.antigravity ?? {};
  const grokBuildControls = agentConfig.providerControls?.grokBuild ?? {};
  const effort = agentConfig.effort || profileEffort || "default";
  const hasPendingProfile = !!pendingProfileName && pendingProfileName !== profileName;
  const pendingConfigBaseline = hasPendingProfile ? createEmptyAgentConfig() : agentConfig;
  const pendingConfigCount = countAgentConfigDifferences(editorConfig, pendingConfigBaseline);
  const pendingCount = pendingConfigCount + (hasPendingProfile ? 1 : 0);
  const editorProfileName = pendingProfileName || profileName;
  const overrideCount =
    pendingCount;
  const claudePermissionMode = agentConfig.providerControls?.claude?.permissionMode;
  const showPermissionMode = isClaudeCodeProvider(effectiveProvider) && !!claudePermissionMode && claudePermissionMode !== "default";
  const toolSummary = isCodexProvider(effectiveProvider)
    ? (codexControls.sandboxMode ?? "sandbox:auto")
    : isAntigravityProvider(effectiveProvider)
      ? summarizeAntigravityTools(agentConfig.toolStates, profileTools, availableTools)
      : isGeminiProvider(effectiveProvider)
        ? summarizeGeminiTools(agentConfig.toolStates, profileTools, availableTools)
      : `${toolCount} tools`;
  return (
    <div className={`config-bar ${open ? "config-bar--open" : ""}`} ref={barRef}>
      <div className="config-bar-header" onClick={() => setOpen(!open)}>
        <svg
          className={`config-bar-chevron ${open ? "config-bar-chevron--open" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
        >
          <path d="M2.5 6.5L5 4L7.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
        <div className="config-bar-items">
          {profileName && (
            <div className="config-bar-profile-wrap">
              <span className={`config-status-dot ${status || "idle"}`} />
              <span className="config-bar-label">{profileName}</span>
            </div>
          )}
          {hasPendingProfile && (
            <span className="config-bar-overrides">next: {pendingProfileName}</span>
          )}
          {model && (
            <>
              <span className="config-bar-sep">·</span>
              <span className="config-bar-value">{shortModel(model)}</span>
            </>
          )}
          <span className="config-bar-sep">·</span>
          <span className="config-bar-value">
            {toolSummary}
          </span>
          <span className="config-bar-sep">·</span>
          {isCodexProvider(effectiveProvider) && (
            <>
              <span className="config-bar-value">{codexControls.serviceTier ?? "speed:auto"}</span>
              <span className="config-bar-sep">·</span>
              <span className="config-bar-value">{codexControls.webSearchMode ?? "web:auto"}</span>
              <span className="config-bar-sep">·</span>
            </>
          )}
          {isAntigravityProvider(effectiveProvider) && (
            <>
              <span className="config-bar-value">{antigravityControls.mode ?? "accept-edits"}</span>
              <span className="config-bar-sep">·</span>
              <span className="config-bar-value">{antigravityControls.sandbox === undefined ? "sandbox:default" : antigravityControls.sandbox ? "sandbox:on" : "sandbox:off"}</span>
              <span className="config-bar-sep">·</span>
            </>
          )}
          {isGrokBuildProvider(effectiveProvider) && (
            <>
              <span className="config-bar-value">{grokBuildControls.mode ?? "default"}</span>
              <span className="config-bar-sep">Â·</span>
            </>
          )}
          <span className="config-bar-value">{effort}</span>
          {overrideCount > 0 && (
            <span className="config-bar-overrides">{overrideCount} override{overrideCount > 1 ? "s" : ""}</span>
          )}
          {showPermissionMode && (
            <span className="config-bar-permission">{claudePermissionMode}</span>
          )}
        </div>
        {sessionId && (
          <button
            className={`config-bar-copy-meta${linkCopied ? " copied" : ""}`}
            onClick={(e) => { e.stopPropagation(); copySessionLink(); }}
            title={isTauriRuntime() ? "Copy link to this session (modus://)" : "Copy link to this session"}
          >
            {linkCopied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M6.5 9.5a2.5 2.5 0 003.6.1l2.2-2.2a2.5 2.5 0 00-3.5-3.5l-1 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                <path d="M9.5 6.5a2.5 2.5 0 00-3.6-.1l-2.2 2.2a2.5 2.5 0 003.5 3.5l1-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        )}
        {sessionId && (
          <button
            className={`config-bar-copy-meta${copied ? " copied" : ""}`}
            onClick={(e) => { e.stopPropagation(); copySessionMetadata(); }}
            title="Copy session metadata to clipboard"
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="5" y="1" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M3 4v9.5a1.5 1.5 0 001.5 1.5H12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            )}
          </button>
        )}
        {onTogglePin && (
          <button
            className={`config-bar-pin-btn${isPinned ? " config-bar-pin-btn--pinned" : ""}`}
            onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
            title={isPinned ? "Unpin session" : "Pin session"}
          >
            <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
              <circle cx="5" cy="3.5" r="2" stroke="currentColor" strokeWidth="1.2" fill={isPinned ? "currentColor" : "none"}/>
              <path d="M5 5.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        )}
        <ChatSettings />
      </div>
      <div className={`config-bar-collapse ${open ? "config-bar-collapse--open" : ""}`}>
        <div className="config-bar-clip">
          <div className="config-bar-panel">
            {profiles && profiles.length > 1 && onSwitchProfile && (
              <div className="agent-config agent-config--compact">
                <div className="agent-config-row">
                  <label className="agent-config-field">
                    <span>profile</span>
                    <SearchDropdown
                      className="search-dropdown--compact"
                      value={editorProfileName ?? ""}
                      options={profileOptions(profiles)}
                      placeholder="select profile"
                      searchPlaceholder="search profiles..."
                      clearable={false}
                      onChange={onSwitchProfile}
                    />
                  </label>
                </div>
              </div>
            )}
            <AgentConfig
              config={editorConfig}
              profileTools={editorProfileTools}
              availableProviders={availableProviders}
              profileProvider={editorProfileProvider}
              profileModel={editorProfileModel}
              profileEffort={editorProfileEffort}
              profileMaxTurns={editorProfileMaxTurns}
              onChange={onAgentConfigChange}
              compact
              showProvider={showProvider}
              availableTools={availableTools}
              toolsCollapsible
            />
          </div>
        </div>
      </div>
    </div>
  );
}
