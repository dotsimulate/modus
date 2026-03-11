import { useState, useRef, useEffect } from "react";
import {
  AgentConfig,
  countAgentConfigDifferences,
  createEmptyAgentConfig,
  type AgentConfigState,
} from "./AgentConfig";
import { SearchDropdown } from "./SearchDropdown";
import { ChatSettings } from "./ChatSettings";
import { getAllTools, getToolGroups, isCodexProvider, isGeminiProvider, isToolEnabled } from "../tools";
import type { Profile, SessionStatus } from "../api";

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
}: Props) {
  const [open, setOpen] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

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
        </div>
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
