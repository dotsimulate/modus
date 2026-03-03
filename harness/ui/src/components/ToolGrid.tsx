/**
 * ToolGrid — reusable three-state tool toggle grid.
 *
 * Each tool cycles through: inherit → on → off → inherit
 * Visual states reflect whether the tool is effectively enabled
 * based on the combination of profile defaults and user overrides.
 *
 * Works standalone — can be placed in sidebar, drawer, popover, or modal.
 */

import { TOOL_GROUPS, ALL_TOOLS, isToolEnabled, type ToolState, type ToolStates } from "../tools";

type Props = {
  /** Current override states (only overridden tools need entries) */
  states: ToolStates;
  /** Profile's tool baseline — string[] of allowed tools, or "all" */
  profileTools: string[] | "all";
  /** Called when any tool state changes */
  onChange: (states: ToolStates) => void;
  /** Compact mode — tighter spacing for popover use */
  compact?: boolean;
};

function nextState(current: ToolState): ToolState {
  if (current === "inherit") return "on";
  if (current === "on") return "off";
  return "inherit";
}

export function ToolGrid({ states, profileTools, onChange, compact }: Props) {
  const toggle = (tool: string) => {
    const current = states[tool] ?? "inherit";
    const next = nextState(current);
    const updated = { ...states };
    if (next === "inherit") {
      delete updated[tool];
    } else {
      updated[tool] = next;
    }
    onChange(updated);
  };

  // Count overrides for summary
  const overrideCount = Object.keys(states).length;
  const enabledCount = ALL_TOOLS.filter((t) =>
    isToolEnabled(t, states[t] ?? "inherit", profileTools),
  ).length;

  return (
    <div className={`tool-grid ${compact ? "tool-grid--compact" : ""}`}>
      <div className="tool-grid-summary">
        <span className="tool-grid-count">{enabledCount}/{ALL_TOOLS.length} tools</span>
        {overrideCount > 0 && (
          <button
            className="tool-grid-reset"
            onClick={() => onChange({})}
          >
            reset
          </button>
        )}
      </div>
      {TOOL_GROUPS.map((group) => (
        <div key={group.label} className="tool-grid-group">
          <div className="tool-grid-group-label">{group.label}</div>
          <div className="tool-grid-pills">
            {group.tools.map((tool) => {
              const state = states[tool] ?? "inherit";
              const enabled = isToolEnabled(tool, state, profileTools);
              const isOverride = state !== "inherit";
              return (
                <button
                  key={tool}
                  className={[
                    "tool-pill",
                    enabled ? "tool-pill--on" : "tool-pill--off",
                    isOverride ? "tool-pill--override" : "",
                    state === "off" ? "tool-pill--forced-off" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => toggle(tool)}
                  title={`${tool}: ${state}${isOverride ? " (override)" : ""}`}
                >
                  {isOverride && <span className="tool-pill-dot" />}
                  {tool}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
