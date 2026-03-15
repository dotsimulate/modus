import { useState, useRef, useEffect, useCallback } from "react";
import {
  AgentConfig,
  countAgentConfigDifferences,
  createEmptyAgentConfig,
  type AgentConfigState,
} from "./AgentConfig";
import { SearchDropdown } from "./SearchDropdown";
import { ChatSettings } from "./ChatSettings";
import { getAllTools, getToolGroups, isClaudeCodeProvider, isCodexProvider, isGeminiProvider, isToolEnabled } from "../tools";
import type { Profile, SessionStatus, Message } from "../api";
import { fetchTouches } from "../api/trace";

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
}: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

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
      const res = await fetchTouches({ sessionId, limit: 200 });
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

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const effectiveProvider = agentConfig.provider || profileProvider;
  const mcpCount = (availableTools ?? []).filter(t => t.startsWith("mcp__")).length;
  const toolCount =
    (profileTools === "all" ? getAllTools(effectiveProvider).length : profileTools.length) + mcpCount;
  const codexControls = agentConfig.providerControls?.codex ?? {};
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
              <span className="config-bar-value">{codexControls.webSearchMode ?? "web:auto"}</span>
              <span className="config-bar-sep">·</span>
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
                      options={profiles.map((p) => ({ value: p.name }))}
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
            />
          </div>
        </div>
      </div>
    </div>
  );
}
