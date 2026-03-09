import { useState, useRef, useEffect } from "react";
import { AgentConfig, type AgentConfigState } from "./AgentConfig";
import { SearchDropdown } from "./SearchDropdown";
import { ChatSettings } from "./ChatSettings";
import { getAllTools } from "../tools";
import type { Profile } from "../api";

type Props = {
  profileName?: string;
  model?: string;
  agentConfig: AgentConfigState;
  onAgentConfigChange: (config: AgentConfigState) => void;
  profileTools: string[] | "all";
  availableProviders?: string[];
  profileProvider?: string;
  profileModel?: string;
  profileEffort?: string;
  profileMaxTurns?: number;
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
  /** Available profiles for live switching */
  profiles?: Profile[];
  /** Called when user switches profile on the live session */
  onSwitchProfile?: (name: string) => void;
};

function shortModel(model?: string): string {
  if (!model) return "";
  return model.replace(/^claude-/, "");
}

export function ConfigBar({
  profileName,
  model,
  agentConfig,
  onAgentConfigChange,
  profileTools,
  availableProviders,
  profileProvider,
  profileModel,
  profileEffort,
  profileMaxTurns,
  availableTools,
  profiles,
  onSwitchProfile,
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
  const effort = agentConfig.effort || profileEffort || "default";
  const overrideCount =
    Object.keys(agentConfig.toolStates).length +
    (agentConfig.model ? 1 : 0) +
    (agentConfig.effort ? 1 : 0) +
    (agentConfig.maxTurns ? 1 : 0);

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
            <span className="config-bar-label">{profileName}</span>
          )}
          {model && (
            <>
              <span className="config-bar-sep">·</span>
              <span className="config-bar-value">{shortModel(model)}</span>
            </>
          )}
          <span className="config-bar-sep">·</span>
          <span className="config-bar-value">{toolCount} tools</span>
          <span className="config-bar-sep">·</span>
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
                      value=""
                      options={profiles
                        .filter((p) => p.name !== profileName)
                        .map((p) => ({ value: p.name }))}
                      placeholder={profileName ?? "select profile"}
                      searchPlaceholder="search profiles..."
                      onChange={onSwitchProfile}
                    />
                  </label>
                </div>
              </div>
            )}
            <AgentConfig
              config={agentConfig}
              profileTools={profileTools}
              availableProviders={availableProviders}
              profileProvider={profileProvider}
              profileModel={profileModel}
              profileEffort={profileEffort}
              profileMaxTurns={profileMaxTurns}
              onChange={onAgentConfigChange}
              compact
              showProvider={false}
              availableTools={availableTools}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
