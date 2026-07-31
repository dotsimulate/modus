/**
 * AgentConfig — the "agent menu" for mutable session settings.
 *
 * Wraps model/provider/tool config for both:
 * - sidebar session seeding
 * - active session config in the chat view
 */

import { useEffect, useRef, useState } from "react";
import { modus } from "../modusClient";
import type { ProviderModel, AgentConfigState } from "../../../sdk/index";
import { providerFallbackModel } from "../../../provider-defaults";
import { SearchDropdown } from "./SearchDropdown";
import { ToolGrid } from "./ToolGrid";
import { useProfiles } from "../providers/ProfileContext";
import { getToolGroups, isAntigravityProvider, isClaudeCodeProvider, isCodexProvider, isGrokBuildProvider, mcpToolGroups, providerDisplayLabel, providerToolFamily, toSdkToolConfig, type ToolStates } from "../tools";

export type { AgentConfigState };

const EFFORT_OPTIONS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

function formatContextWindow(tokens?: number): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

export type SessionConfigPatch = {
  provider?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  toolStates?: ToolStates;
  providerControls?: AgentConfigState["providerControls"];
};

export type SessionConfigUpdate = {
  provider: string;
  model: string;
  effort: string;
  maxTurns: number | null;
  tools: string[];
  disallowedTools: string[];
  toolStates: ToolStates;
  providerControls: AgentConfigState["providerControls"];
};

type Props = {
  /** Current config state */
  config: AgentConfigState;
  /** Profile's tool baseline */
  profileTools: string[] | "all";
  /** Profile's default model */
  profileModel?: string;
  /** Available providers from backend registry */
  availableProviders?: string[];
  /** Profile's default provider */
  profileProvider?: string;
  /** Profile's default effort */
  profileEffort?: string;
  /** Profile's default maxTurns */
  profileMaxTurns?: number;
  /** Called on any change */
  onChange: (config: AgentConfigState) => void;
  /** Compact mode for popover use */
  compact?: boolean;
  /** Search dropdown direction for provider/effort fields */
  dropdownDirection?: "up" | "down";
  /** Show/hide provider field */
  showProvider?: boolean;
  /** Show/hide tools section (can collapse) */
  toolsCollapsible?: boolean;
  /** All tools reported by SDK init (for MCP tool discovery) */
  availableTools?: string[];
};

export function AgentConfig({
  config,
  profileTools,
  profileModel,
  availableProviders,
  profileProvider,
  profileEffort,
  profileMaxTurns,
  onChange,
  compact,
  dropdownDirection = "down",
  showProvider = true,
  toolsCollapsible,
  availableTools,
}: Props) {
  const [toolsOpen, setToolsOpen] = useState(!toolsCollapsible);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const configRef = useRef(config);
  const { providerCapabilities } = useProfiles();
  const dropdownClassName = dropdownDirection === "up"
    ? "search-dropdown--compact search-dropdown--up"
    : "search-dropdown--compact";
  const effectiveProvider = config.provider || profileProvider || "claude-code";
  // Prefer the backend's reported built-in tools for the live provider; fall
  // back to the static catalog when capabilities haven't loaded yet.
  const builtInGroups = providerCapabilities[effectiveProvider]?.builtInToolGroups
    ?? getToolGroups(effectiveProvider, providerCapabilities[effectiveProvider]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    modus.getProviderModels(effectiveProvider).then(setProviderModels).catch(() => setProviderModels([]));
  }, [effectiveProvider]);

  const update = (patch: Partial<AgentConfigState>) => {
    onChange({ ...config, ...patch });
  };

  const updateProvider = (provider: string) => {
    const previousProvider = config.provider || profileProvider;
    const nextProvider = provider || profileProvider;
    const switchingToolFamilies =
      providerToolFamily(previousProvider, previousProvider ? providerCapabilities[previousProvider] : undefined)
      !== providerToolFamily(nextProvider, nextProvider ? providerCapabilities[nextProvider] : undefined);
    const nextConfig = {
      ...config,
      provider,
      model: "",
      ...(switchingToolFamilies ? { toolStates: {} } : {}),
      providerControls: {
        ...(isCodexProvider(provider || profileProvider) ? { codex: config.providerControls?.codex } : {}),
        ...(isClaudeCodeProvider(provider || profileProvider) ? { claude: config.providerControls?.claude } : {}),
        ...(isAntigravityProvider(provider || profileProvider) ? { antigravity: config.providerControls?.antigravity } : {}),
        ...(isGrokBuildProvider(provider || profileProvider) ? { grokBuild: config.providerControls?.grokBuild } : {}),
      },
    };
    onChange(nextConfig);

    if (!provider) return;

    const fallbackModel = providerSeedModel(provider);
    void modus.getProviderModels(provider).then((models) => {
      const latest = configRef.current;
      if ((latest.provider || profileProvider || "claude-code") !== provider) return;
      if (latest.model.trim()) return;
      const seededModel = models[0]?.id ?? fallbackModel;
      if (!seededModel) return;
      onChange({ ...latest, model: seededModel });
    }).catch(() => {
      const latest = configRef.current;
      if ((latest.provider || profileProvider || "claude-code") !== provider) return;
      if (latest.model.trim() || !fallbackModel) return;
      onChange({ ...latest, model: fallbackModel });
    });
  };

  const codexControls = config.providerControls?.codex ?? {};
  const updateCodexControls = (patch: NonNullable<NonNullable<AgentConfigState["providerControls"]>["codex"]>) => {
    const nextCodexControls = Object.fromEntries(
      Object.entries({ ...codexControls, ...patch }).filter(([, value]) => !!value),
    ) as NonNullable<NonNullable<AgentConfigState["providerControls"]>["codex"]>;
    update({
      providerControls: {
        ...(config.providerControls ?? {}),
        codex: nextCodexControls,
      },
    });
  };

  const claudeControls = config.providerControls?.claude ?? {};
  const updateClaudeControls = (patch: NonNullable<NonNullable<AgentConfigState["providerControls"]>["claude"]>) => {
    update({
      providerControls: {
        ...(config.providerControls ?? {}),
        claude: { ...claudeControls, ...patch },
      },
    });
  };

  const antigravityControls = config.providerControls?.antigravity ?? {};
  const updateAntigravityControls = (patch: NonNullable<NonNullable<AgentConfigState["providerControls"]>["antigravity"]>) => {
    update({
      providerControls: {
        ...(config.providerControls ?? {}),
        antigravity: { ...antigravityControls, ...patch },
      },
    });
  };

  const grokBuildControls = config.providerControls?.grokBuild ?? {};
  const updateGrokBuildControls = (patch: NonNullable<NonNullable<AgentConfigState["providerControls"]>["grokBuild"]>) => {
    update({
      providerControls: {
        ...(config.providerControls ?? {}),
        grokBuild: { ...grokBuildControls, ...patch },
      },
    });
  };

  return (
    <div className={`agent-config ${compact ? "agent-config--compact" : ""}`}>
      {/* Model + Provider + Effort + Max Turns row */}
      <div className="agent-config-row">
        <label className="agent-config-field">
          <span>model</span>
          <SearchDropdown
            className={dropdownClassName}
            value={config.model}
            options={providerModels
              .filter((v) => v.id !== profileModel)
              .map((v) => {
                const context = formatContextWindow(v.contextWindow);
                return {
                  value: v.id,
                  label: context ? `${v.id}  ${context} ctx` : v.id,
                };
              })}
            placeholder={profileModel ?? "default"}
            searchPlaceholder="search models..."
            allowCustom
            onChange={(model) => update({ model })}
          />
        </label>
        {showProvider && availableProviders && availableProviders.length > 1 && (
          <label className="agent-config-field">
            <span>provider</span>
            <SearchDropdown
              className={dropdownClassName}
              value={config.provider}
              options={availableProviders
                .filter((v) => v !== profileProvider)
                .map((v) => ({
                  value: v,
                  label: providerDisplayLabel(v, providerCapabilities[v]),
                }))}
              placeholder={providerDisplayLabel(
                profileProvider ?? "claude-code",
                providerCapabilities[profileProvider ?? "claude-code"],
              )}
              searchPlaceholder="search providers..."
              onChange={updateProvider}
            />
          </label>
        )}
        <label className="agent-config-field">
          <span>effort</span>
          <SearchDropdown
            className={dropdownClassName}
            value={config.effort}
            options={EFFORT_OPTIONS
              .filter((v) => v !== profileEffort)
              .map((v) => ({ value: v }))}
            placeholder={profileEffort ?? "default"}
            searchPlaceholder="search effort..."
            onChange={(effort) => update({ effort })}
          />
        </label>
        <label className="agent-config-field">
          <span>turns</span>
          <input
            type="number"
            value={config.maxTurns}
            onChange={(e) => update({ maxTurns: e.target.value })}
            placeholder={profileMaxTurns ? String(profileMaxTurns) : "no limit"}
            min={1}
            max={100}
          />
        </label>
      </div>

      {/* Provider-specific runtime controls */}
      {isCodexProvider(effectiveProvider) ? (
        <div className="agent-config-row">
          <label className="agent-config-field">
            <span>sandbox</span>
            <SearchDropdown
              className={dropdownClassName}
              value={codexControls.sandboxMode ?? ""}
              options={[
                { value: "danger-full-access" },
                { value: "workspace-write" },
                { value: "read-only" },
              ]}
              placeholder="profile default"
              searchPlaceholder="search sandbox..."
              onChange={(sandboxMode) => updateCodexControls({
                sandboxMode: sandboxMode as NonNullable<NonNullable<AgentConfigState["providerControls"]>["codex"]>["sandboxMode"],
              })}
            />
          </label>
          <label className="agent-config-field">
            <span>web</span>
            <SearchDropdown
              className={dropdownClassName}
              value={codexControls.webSearchMode ?? ""}
              options={[
                { value: "live" },
                { value: "disabled" },
                { value: "cached" },
              ]}
              placeholder="profile default"
              searchPlaceholder="search web mode..."
              onChange={(webSearchMode) => updateCodexControls({
                webSearchMode: webSearchMode as NonNullable<NonNullable<AgentConfigState["providerControls"]>["codex"]>["webSearchMode"],
              })}
            />
          </label>
          <label className="agent-config-field">
            <span>speed</span>
            <SearchDropdown
              className={dropdownClassName}
              value={codexControls.serviceTier ?? ""}
              options={[
                { value: "fast", label: "fast" },
                { value: "standard", label: "standard" },
                { value: "priority", label: "priority API" },
              ]}
              placeholder="profile default"
              searchPlaceholder="search speed..."
              onChange={(serviceTier) => updateCodexControls({
                serviceTier: serviceTier as NonNullable<NonNullable<AgentConfigState["providerControls"]>["codex"]>["serviceTier"],
              })}
            />
          </label>
        </div>
      ) : null}

      {/* Claude-specific runtime controls */}
      {isClaudeCodeProvider(effectiveProvider) ? (
        <div className="agent-config-row">
          <label className="agent-config-field">
            <span>permissions</span>
            <SearchDropdown
              className={dropdownClassName}
              value={claudeControls.permissionMode ?? ""}
              options={[
                { value: "default" },
                { value: "acceptEdits" },
                { value: "plan" },
                { value: "dontAsk" },
              ]}
              placeholder="profile default"
              searchPlaceholder="search permission mode..."
              onChange={(permissionMode) => updateClaudeControls({
                permissionMode: permissionMode as NonNullable<NonNullable<AgentConfigState["providerControls"]>["claude"]>["permissionMode"],
              })}
            />
          </label>
        </div>
      ) : null}

      {/* Antigravity headless controls map directly to documented agy flags. */}
      {isAntigravityProvider(effectiveProvider) ? (
        <div className="agent-config-row">
          <label className="agent-config-field">
            <span>mode</span>
            <SearchDropdown
              className={dropdownClassName}
              value={antigravityControls.mode ?? ""}
              options={[{ value: "accept-edits" }, { value: "plan" }]}
              placeholder="accept-edits"
              searchPlaceholder="search mode..."
              onChange={(mode) => updateAntigravityControls({
                mode: (mode || undefined) as NonNullable<NonNullable<AgentConfigState["providerControls"]>["antigravity"]>["mode"],
              })}
            />
          </label>
          <label className="agent-config-field">
            <span>sandbox</span>
            <SearchDropdown
              className={dropdownClassName}
              value={antigravityControls.sandbox === undefined ? "" : antigravityControls.sandbox ? "enabled" : "disabled"}
              options={[{ value: "enabled" }, { value: "disabled" }]}
              placeholder="profile default"
              searchPlaceholder="search sandbox..."
              onChange={(sandbox) => updateAntigravityControls({
                sandbox: sandbox ? sandbox === "enabled" : undefined,
              })}
            />
          </label>
        </div>
      ) : null}

      {isGrokBuildProvider(effectiveProvider) ? (
        <div className="agent-config-row">
          <label className="agent-config-field">
            <span>mode</span>
            <SearchDropdown
              className={dropdownClassName}
              value={grokBuildControls.mode ?? ""}
              options={[{ value: "default" }, { value: "auto" }, { value: "plan" }, { value: "always-approve" }]}
              placeholder="default"
              searchPlaceholder="search mode..."
              onChange={(mode) => updateGrokBuildControls({
                mode: (mode || undefined) as NonNullable<NonNullable<AgentConfigState["providerControls"]>["grokBuild"]>["mode"],
              })}
            />
          </label>
          <label className="agent-config-field">
            <span>memory</span>
            <SearchDropdown
              className={dropdownClassName}
              value={grokBuildControls.noMemory === undefined ? "" : grokBuildControls.noMemory ? "disabled" : "enabled"}
              options={[{ value: "enabled" }, { value: "disabled" }]}
              placeholder="profile default"
              searchPlaceholder="search memory mode..."
              onChange={(memory) => updateGrokBuildControls({ noMemory: memory ? memory === "disabled" : undefined })}
            />
          </label>
          <label className="agent-config-field">
            <span>web</span>
            <SearchDropdown
              className={dropdownClassName}
              value={grokBuildControls.disableWebSearch === undefined ? "" : grokBuildControls.disableWebSearch ? "disabled" : "enabled"}
              options={[{ value: "enabled" }, { value: "disabled" }]}
              placeholder="profile default"
              searchPlaceholder="search web mode..."
              onChange={(web) => updateGrokBuildControls({ disableWebSearch: web ? web === "disabled" : undefined })}
            />
          </label>
        </div>
      ) : null}

      {/* Tools section */}
      {toolsCollapsible ? (
        <button
          className="agent-config-tools-toggle"
          onClick={() => setToolsOpen(!toolsOpen)}
        >
          <span>{toolsOpen ? "−" : "+"} tools</span>
        </button>
      ) : null}

      {isCodexProvider(effectiveProvider) ? (
        // Codex tools are governed by sandbox mode, not per-tool toggles —
        // surface the built-ins read-only so it's clear what the agent has.
        <div className={`panel-collapse ${toolsOpen ? "panel-collapse--open" : ""}`}>
          <div className="panel-collapse-clip">
            <div className="tool-grid tool-grid--readonly">
              <div className="tool-grid-summary">
                <span className="tool-grid-count">built-in · sandbox-managed</span>
              </div>
              <div className="tool-grid-groups">
                {builtInGroups.map((group) => (
                  <div key={group.label} className="tool-grid-group">
                    <div className="tool-grid-group-label">{group.label}</div>
                    <div className="tool-grid-pills">
                      {group.tools.map((tool) => (
                        <span key={tool} className="tool-pill tool-pill--on tool-pill--readonly" title={`${tool}: built-in`}>
                          {tool}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className={`panel-collapse ${toolsOpen ? "panel-collapse--open" : ""}`}>
          <div className="panel-collapse-clip">
            <ToolGrid
              states={config.toolStates}
              profileTools={profileTools}
              onChange={(toolStates) => update({ toolStates })}
              compact={compact}
              extraGroups={mcpToolGroups(availableTools ?? [])}
              provider={effectiveProvider}
              builtInGroups={builtInGroups}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function providerSeedModel(provider: string): string {
  return providerFallbackModel(provider);
}

export function createEmptyAgentConfig(): AgentConfigState {
  return {
    toolStates: {},
    model: "",
    provider: "",
    effort: "",
    maxTurns: "",
    providerControls: {},
  };
}

function equalStringRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function equalProviderControls(
  left: AgentConfigState["providerControls"],
  right: AgentConfigState["providerControls"],
): boolean {
  const leftCodex = left?.codex ?? {};
  const rightCodex = right?.codex ?? {};
  const leftClaude = left?.claude ?? {};
  const rightClaude = right?.claude ?? {};
  const leftAntigravity = left?.antigravity ?? {};
  const rightAntigravity = right?.antigravity ?? {};
  return (
    leftCodex.sandboxMode === rightCodex.sandboxMode
    && leftCodex.webSearchMode === rightCodex.webSearchMode
    && leftCodex.serviceTier === rightCodex.serviceTier
    && leftClaude.permissionMode === rightClaude.permissionMode
    && leftAntigravity.mode === rightAntigravity.mode
    && leftAntigravity.sandbox === rightAntigravity.sandbox
    && leftAntigravity.printTimeout === rightAntigravity.printTimeout
  );
}

export function isAgentConfigEqual(left: AgentConfigState, right: AgentConfigState): boolean {
  return (
    left.model === right.model
    && left.provider === right.provider
    && left.effort === right.effort
    && left.maxTurns === right.maxTurns
    && equalStringRecord(left.toolStates, right.toolStates)
    && equalProviderControls(left.providerControls, right.providerControls)
  );
}

export function countAgentConfigDifferences(left: AgentConfigState, right: AgentConfigState): number {
  let count = 0;
  if (left.model !== right.model) count++;
  if (left.provider !== right.provider) count++;
  if (left.effort !== right.effort) count++;
  if (left.maxTurns !== right.maxTurns) count++;
  if (!equalStringRecord(left.toolStates, right.toolStates)) count++;
  if (!equalProviderControls(left.providerControls, right.providerControls)) count++;
  return count;
}

/** Convert AgentConfigState to SDK-compatible overrides */
export function agentConfigToOverrides(
  config: AgentConfigState,
  profileTools: string[] | "all",
): SessionConfigPatch {
  const toolConfig = toSdkToolConfig(config.toolStates, profileTools);
  return {
    ...toolConfig,
    ...(config.provider.trim() ? { provider: config.provider } : {}),
    ...(config.model.trim() ? { model: config.model } : {}),
    ...(config.maxTurns.trim() ? { maxTurns: Number(config.maxTurns) } : {}),
    ...(config.effort.trim() ? { effort: config.effort } : {}),
    toolStates: config.toolStates,
    providerControls: config.providerControls,
  };
}

/** Convert AgentConfigState to session config update payload, preserving explicit clears. */
export function agentConfigToUpdatePayload(
  config: AgentConfigState,
  profileTools: string[] | "all",
): SessionConfigUpdate {
  const toolConfig = toSdkToolConfig(config.toolStates, profileTools);
  return {
    provider: config.provider.trim(),
    model: config.model.trim(),
    effort: config.effort.trim(),
    maxTurns: config.maxTurns.trim() ? Number(config.maxTurns) : null,
    tools: "tools" in toolConfig ? (toolConfig.tools ?? []) : [],
    disallowedTools: "disallowedTools" in toolConfig ? (toolConfig.disallowedTools ?? []) : [],
    toolStates: config.toolStates,
    providerControls: config.providerControls ?? {},
  };
}
