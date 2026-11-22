/**
 * ToolGrid — reusable tool toggle grid.
 *
 * Two modes:
 * - "override" (default): Three-state (inherit → on → off → inherit).
 *   Used for session-level overrides against a profile baseline.
 * - "baseline": Two-state (on/off). Used for defining which tools a
 *   profile includes. No "inherit" concept — you're setting the baseline.
 */

import { effectiveToolState, getToolGroups, isToolEnabled, mcpToolDisplayName, type ToolGroup, type ToolState, type ToolStates } from "../tools";

type BaseProps = {
  /** Called when any tool state changes */
  onChange: (states: ToolStates) => void;
  /** Compact mode — tighter spacing for popover use */
  compact?: boolean;
  /** Additional tool groups (e.g., MCP tools discovered at runtime) */
  extraGroups?: ToolGroup[];
  /** Provider name — determines which built-in tool set to show */
  provider?: string;
  /**
   * Authoritative built-in groups from the backend provider capabilities.
   * When provided, these win over the static per-provider fallback so the grid
   * reflects exactly what the running provider exposes.
   */
  builtInGroups?: ToolGroup[];
  /**
   * The provider's map from shared tool names (`Read`, `Bash`, ...) to its own,
   * from its capabilities. Lets a profile's tools and toggles written with shared
   * names show on this provider's pills the way the backend applies them.
   */
  toolAliases?: Record<string, string[]>;
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

type PermissionProps = BaseProps & {
  mode: "permission";
  states: ToolStates;
  profileTools?: undefined;
};

type Props = OverrideProps | BaselineProps | PermissionProps;

function nextOverrideState(current: ToolState): ToolState {
  if (current === "inherit") return "on";
  if (current === "on") return "off";
  return "inherit";
}

export function ToolGrid(props: Props) {
  const { states, onChange, compact } = props;
  const mode = props.mode ?? "override";
  const profileTools = mode === "override" ? (props as OverrideProps).profileTools : "all";
  const extraGroups = props.extraGroups;

  const builtinGroups = props.builtInGroups?.length ? props.builtInGroups : getToolGroups(props.provider);
  const builtinTools = builtinGroups.flatMap((g) => g.tools);
  const groups = extraGroups?.length ? [...builtinGroups, ...extraGroups] : builtinGroups;
  const allTools = extraGroups?.length ? groups.flatMap(g => g.tools) : builtinTools;

  const overrideCount = Object.keys(states).length;

  const toggle = (tool: string) => {
    if (mode === "baseline" && overrideCount === 0) {
      // "All tools" → clicking one means "all except this one"
      const updated: ToolStates = {};
      for (const t of allTools) updated[t] = "on";
      delete updated[tool];
      onChange(updated);
      return;
    }

    const current = states[tool] ?? "inherit";
    const effective = effectiveToolState(tool, states, props.toolAliases);
    const updated = { ...states };

    if (mode === "baseline") {
      // Two-state: on ↔ off (no inherit). When a tool is enabled via a shared
      // alias (e.g. Claude `Bash` covering Antigravity `run_command`), resolve
      // the current baseline into native tool pills before toggling it off.
      if (effective === "on") {
        if (current === "on") {
          delete updated[tool];
        } else {
          const resolved: ToolStates = {};
          for (const t of allTools) {
            if (t !== tool && effectiveToolState(t, states, props.toolAliases) === "on") resolved[t] = "on";
          }
          onChange(resolved);
          return;
        }
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
    ? (overrideCount === 0
        ? allTools.length
        : allTools.filter((t) => effectiveToolState(t, states, props.toolAliases) === "on").length)
    : allTools.filter((t) => isToolEnabled(t, effectiveToolState(t, states, props.toolAliases), profileTools, props.toolAliases)).length;

  const totalLabel = mode === "permission"
    ? `${overrideCount} exception${overrideCount === 1 ? "" : "s"}`
    : mode === "baseline"
      ? (overrideCount === 0 ? "all tools" : `${enabledCount} tools`)
      : `${enabledCount}/${allTools.length} tools`;

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
      <div className="tool-grid-groups">
        {groups.map((group) => (
          <div key={group.label} className="tool-grid-group">
            <div className="tool-grid-group-label">{group.label}</div>
            <div className="tool-grid-pills">
              {group.tools.map((tool) => {
                const state = states[tool] ?? "inherit";
                const effective = effectiveToolState(tool, states, props.toolAliases);
                const isMcp = tool.startsWith("mcp__");
                const displayName = isMcp ? mcpToolDisplayName(tool) : tool;

                let enabled: boolean;
                let isOverride: boolean;

                if (mode === "baseline") {
                  enabled = overrideCount === 0 || effective === "on";
                  isOverride = effective === "on";
                } else if (mode === "permission") {
                  enabled = state !== "off";
                  isOverride = state !== "inherit";
                } else {
                  enabled = isToolEnabled(tool, effective, profileTools, props.toolAliases);
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
                    title={mode === "permission"
                      ? `${tool}: ${state === "on" ? "auto-approve" : state === "off" ? "ask" : "inherit mode"}`
                      : mode === "baseline"
                        ? `${tool}: ${enabled ? "included" : "excluded"}`
                        : `${tool}: ${state}${isOverride ? " (override)" : ""}`
                    }
                  >
                    {isOverride && <span className="tool-pill-dot" />}
                    {displayName}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
