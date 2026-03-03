import { useState } from "react";
import type { ToolCall as ToolCallType } from "../types";

type Props = {
  tool: ToolCallType;
};

export function ToolCallView({ tool }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`tool-call ${tool.status}`}>
      <div className="tool-call-header" onClick={() => setExpanded(!expanded)}>
        <span className="tool-call-indicator">
          {tool.status === "running" && <span className="tool-spinner" />}
          {tool.status === "completed" && <span className="tool-check">+</span>}
          {tool.status === "error" && <span className="tool-error">!</span>}
        </span>
        <span className="tool-call-name">{tool.name}</span>
        {tool.duration != null && (
          <span className="tool-call-duration">{(tool.duration / 1000).toFixed(1)}s</span>
        )}
        <span className="tool-call-expand">{expanded ? "-" : "+"}</span>
      </div>

      {expanded && (
        <div className="tool-call-detail">
          <div className="tool-call-section">
            <div className="tool-call-section-label">input</div>
            <pre className="tool-call-json">{tool.inputStr}</pre>
          </div>
          {tool.result != null && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">output</div>
              <pre className="tool-call-json">{tool.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
