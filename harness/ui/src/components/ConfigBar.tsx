import { useState, useRef, useEffect } from "react";
import { AgentConfig, type AgentConfigState } from "./AgentConfig";
import { ALL_TOOLS } from "../tools";

type Props = {
  profileName?: string;
  model?: string;
  agentConfig: AgentConfigState;
  onAgentConfigChange: (config: AgentConfigState) => void;
  profileTools: string[] | "all";
  profileEffort?: string;
  profileMaxTurns?: number;
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
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
  profileEffort,
  profileMaxTurns,
  availableTools,
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

  const mcpCount = (availableTools ?? []).filter(t => t.startsWith("mcp__")).length;
  const toolCount =
    (profileTools === "all" ? ALL_TOOLS.length : profileTools.length) + mcpCount;
  const effort = agentConfig.effort || profileEffort || "default";
  const overrideCount =
    Object.keys(agentConfig.toolStates).length +
    (agentConfig.effort ? 1 : 0) +
    (agentConfig.maxTurns ? 1 : 0);

  return (
    <div className={`config-bar ${open ? "config-bar--open" : ""}`} ref={barRef}>
      <div className="config-bar-header" onClick={() => setOpen(!open)}>
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
        <svg
          className={`config-bar-chevron ${open ? "config-bar-chevron--open" : ""}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
        >
          <path d="M2.5 6.5L5 4L7.5 6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
        </svg>
      </div>
      <div className={`config-bar-collapse ${open ? "config-bar-collapse--open" : ""}`}>
        <div className="config-bar-clip">
          <div className="config-bar-panel">
            <AgentConfig
              config={agentConfig}
              profileTools={profileTools}
              profileEffort={profileEffort}
              profileMaxTurns={profileMaxTurns}
              onChange={onAgentConfigChange}
              compact
              availableTools={availableTools}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
