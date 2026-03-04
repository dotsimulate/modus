/**
 * ToolGrid — reusable tool toggle grid.
 *
 * Two modes:
 * - "override" (default): Three-state (inherit → on → off → inherit).
 *   Used for session-level overrides against a profile baseline.
 * - "baseline": Two-state (on/off). Used for defining which tools a
 *   profile includes. No "inherit" concept — you're setting the baseline.
 */

import { TOOL_GROUPS, ALL_TOOLS, isToolEnabled, type ToolState, type ToolStates } from "../tools";

type BaseProps = {
  /** Called when any tool state changes */
  onChange: (states: ToolStates) => void;
  /** Compact mode — tighter spacing for popover use */
  compact?: boolean;
};

type OverrideProps = BaseProps & {
  mode?: "override";
  /** Current override states (only overridden tools need entries) */
  states: ToolStates;
  /** Profile's tool baseline — string[] of allowed tools, or "all" */
  profileTools: string[] | "all";
};

type BaselineProps = BaseProps & {
  mode: "baseline";
  /** Current override states — "on" means included, absent means excluded */
  states: ToolStates;
  profileTools?: undefined;
};

type Props = OverrideProps | BaselineProps;

function nextOverrideState(current: ToolState): ToolState {
  if (current === "inherit") return "on";
  if (current === "on") return "off";
  return "inherit";
}

export function ToolGrid(props: Props) {
  const { states, onChange, compact } = props;
  const mode = props.mode ?? "override";
  const profileTools = mode === "override" ? (props as OverrideProps).profileTools : "all";

  const overrideCount = Object.keys(states).length;

  const toggle = (tool: string) => {
    if (mode === "baseline" && overrideCount === 0) {
      // "All tools" → clicking one means "all except this one"
      const updated: ToolStates = {};
      for (const t of ALL_TOOLS) updated[t] = "on";
      delete updated[tool];
      onChange(updated);
      return;
    }

    const current = states[tool] ?? "inherit";
    const updated = { ...states };

    if (mode === "baseline") {
      // Two-state: on ↔ off (no inherit)
      if (current === "on") {
        delete updated[tool]; // remove = off
      } else {
        updated[tool] = "on";
      }
    } else {
      // Three-state: inherit → on → off → inherit
      const next = nextOverrideState(current);
      if (next === "inherit") {
        delete updated[tool];
      } else {
        updated[tool] = next;
      }
    }
    onChange(updated);
  };

  const enabledCount = mode === "baseline"
    ? Object.values(states).filter((s) => s === "on").length
    : ALL_TOOLS.filter((t) => isToolEnabled(t, states[t] ?? "inherit", profileTools)).length;

  const totalLabel = mode === "baseline"
    ? `${enabledCount || "all"} tools`
    : `${enabledCount}/${ALL_TOOLS.length} tools`;

  const resetLabel = mode === "baseline" ? "clear" : "reset";

  return (
    <div className={`tool-grid ${compact ? "tool-grid--compact" : ""}`}>
      <div className="tool-grid-summary">
        <span className="tool-grid-count">{totalLabel}</span>
        {overrideCount > 0 && (
          <button
            className="tool-grid-reset"
            onClick={() => onChange({})}
          >
            {resetLabel}
          </button>
        )}
      </div>
      {TOOL_GROUPS.map((group) => (
        <div key={group.label} className="tool-grid-group">
          <div className="tool-grid-group-label">{group.label}</div>
          <div className="tool-grid-pills">
            {group.tools.map((tool) => {
              const state = states[tool] ?? "inherit";

              let enabled: boolean;
              let isOverride: boolean;

              if (mode === "baseline") {
                // Baseline: "on" = included, anything else = excluded
                // No states at all = "all tools" (nothing overridden)
                enabled = overrideCount === 0 || state === "on";
                isOverride = state === "on";
              } else {
                enabled = isToolEnabled(tool, state, profileTools);
                isOverride = state !== "inherit";
              }

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
                  title={mode === "baseline"
                    ? `${tool}: ${enabled ? "included" : "excluded"}`
                    : `${tool}: ${state}${isOverride ? " (override)" : ""}`
                  }
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
