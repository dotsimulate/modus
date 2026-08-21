import { useState } from "react";
import type { PermissionPolicy } from "../../../sdk/index";
import { ToolGrid } from "./ToolGrid";
import type { ToolGroup, ToolStates } from "../tools";

type Props = {
  value?: PermissionPolicy;
  onChange: (value: PermissionPolicy | undefined) => void;
  provider: string;
  builtInGroups?: ToolGroup[];
  compact?: boolean;
};

const MODES = [
  { value: "", label: "inherit", help: "profile default; bypass when absent everywhere" },
  { value: "bypass", label: "bypass", help: "never ask" },
  { value: "auto-edit", label: "auto-edit", help: "edits ok, ask for shell" },
  { value: "ask", label: "ask", help: "ask for everything" },
] as const;

function modeOf(value?: PermissionPolicy): "" | "bypass" | "auto-edit" | "ask" {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.default === "ask" ? "ask" : "bypass";
}

function statesOf(value?: PermissionPolicy): ToolStates {
  if (!value || typeof value === "string") return {};
  const states: ToolStates = {};
  for (const tool of value.autoApprove ?? []) states[tool] = "on";
  for (const tool of value.requireApproval ?? []) states[tool] = "off";
  return states;
}

function shellTools(provider: string): string[] {
  if (provider === "grok-build") return ["run_terminal_cmd"];
  if (provider === "antigravity") return ["run_command"];
  if (provider === "opencode") return ["bash"];
  return ["Bash", "PowerShell"];
}

export function PermissionPolicyControl({ value, onChange, provider, builtInGroups, compact }: Props) {
  const [advancedOpen, setAdvancedOpen] = useState(typeof value === "object");
  const mode = modeOf(value);
  const states = statesOf(value);
  const warning = typeof value === "object" && ["codex", "gemini-cli", "opencode"].includes(provider)
    ? `${provider} flattens per-tool exceptions to the selected default.`
    : provider === "codex" && mode === "ask"
      ? "Codex exec cannot pause for approval; it uses workspace-write containment instead."
      : provider === "opencode" && mode === "auto-edit"
        ? "OpenCode has no exact auto-edit mode; it keeps native permissions enabled."
        : null;

  const setMode = (next: string) => {
    onChange(next ? next as PermissionPolicy : undefined);
  };

  const openAdvanced = () => {
    setAdvancedOpen(true);
    if (typeof value === "object") return;
    const requireApproval = mode === "auto-edit" ? shellTools(provider) : [];
    onChange({
      default: mode === "ask" ? "ask" : "approve",
      ...(requireApproval.length ? { requireApproval } : {}),
    });
  };

  const setStates = (next: ToolStates) => {
    const base = typeof value === "object" ? value : { default: mode === "ask" ? "ask" as const : "approve" as const };
    const autoApprove = Object.entries(next).filter(([, state]) => state === "on").map(([tool]) => tool);
    const requireApproval = Object.entries(next).filter(([, state]) => state === "off").map(([tool]) => tool);
    onChange({
      default: base.default,
      ...(autoApprove.length ? { autoApprove } : {}),
      ...(requireApproval.length ? { requireApproval } : {}),
    });
  };

  return (
    <div className={`permission-policy${compact ? " permission-policy--compact" : ""}`}>
      <div className="pf-tools-mode permission-policy-modes">
        {MODES.map((item) => (
          <button
            key={item.value || "inherit"}
            type="button"
            className={`pf-tools-mode-btn${mode === item.value ? " pf-tools-mode-btn--on" : ""}`}
            onClick={() => setMode(item.value)}
            title={item.help}
          >{item.label}</button>
        ))}
      </div>
      <div className="permission-policy-help">{MODES.find((item) => item.value === mode)?.help}</div>
      {warning && <div className="pf-warn permission-policy-warning">{warning}</div>}
      {!advancedOpen ? (
        <button type="button" className="apc-action permission-policy-advanced" onClick={openAdvanced}>+ per-tool exceptions</button>
      ) : (
        <div className="permission-policy-tools">
          <button type="button" className="apc-action permission-policy-advanced" onClick={() => setAdvancedOpen(false)}>hide per-tool exceptions</button>
          <ToolGrid
            mode="permission"
            states={states}
            onChange={setStates}
            compact
            provider={provider}
            builtInGroups={builtInGroups}
          />
        </div>
      )}
    </div>
  );
}
