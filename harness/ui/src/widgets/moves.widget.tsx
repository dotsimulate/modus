/**
 * Moves widget — compact grid of available moves with lucide icons.
 *
 * Harness-level widget: always available on dashboard or left panel.
 * Click a chip to expand it inline: shows description, inputs (if any),
 * and an "attach" button. Replaces the grid while expanded.
 *
 * Always attaches to the composer — never activates directly.
 * Dispatches "modus:attach-move" event; ChatInput picks it up and
 * runs the same attach logic as the PromptPicker (mountOnAttach,
 * regular chip, persistent — all handled by ChatInput).
 */

import { useState, useCallback } from "react";
import { fetchMoves } from "../api";
import type { MoveListItem, MoveInput } from "../api";
import { useProfiles } from "../providers/ProfileProvider";
import type { WidgetDef, WidgetProps } from "./index";
import { WidgetEmptyState } from "./widget-components";
import { useWidgetPollingValue } from "./widget-data";
import * as icons from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ── Icon resolution ──

function resolveIcon(name?: string): LucideIcon | null {
  if (!name) return null;
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (icons as Record<string, unknown>)[pascal] as LucideIcon | undefined ?? null;
}

// ── Input helpers (match PromptPicker's buildMoveInputs) ──

function stringifyDefault(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "yes" : "";
  return String(value);
}

function selectOptions(
  input: MoveInput,
  profileNames: string[],
): string[] {
  if (Array.isArray(input.options)) return input.options;
  if (input.options === "{{agentProfiles}}") return profileNames;
  return [];
}

function buildMoveInputs(
  move: MoveListItem,
  values: Record<string, string>,
  profileNames: string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const input of move.inputs ?? []) {
    const raw = values[input.name] ?? stringifyDefault(input.default);
    if (input.type === "toggle") {
      result[input.name] = raw === "yes";
      continue;
    }
    if (input.type === "number") {
      const trimmed = raw.trim();
      if (trimmed) result[input.name] = Number(trimmed);
      continue;
    }
    if (input.type === "select") {
      const options = selectOptions(input, profileNames);
      const resolved = raw || options[0] || "";
      if (resolved) result[input.name] = resolved;
      continue;
    }
    if (raw.trim()) result[input.name] = raw;
  }
  return result;
}

function isMoveInputReady(
  move: MoveListItem,
  values: Record<string, string>,
  profileNames: string[],
): boolean {
  return (move.inputs ?? []).every((input) => {
    if (!input.required) return true;
    if (input.type === "toggle") return values[input.name] !== undefined;
    const options = selectOptions(input, profileNames);
    if (input.type === "select" && options.length > 0) {
      return !!(values[input.name] ?? stringifyDefault(input.default) ?? options[0]);
    }
    return !!String(values[input.name] ?? stringifyDefault(input.default)).trim();
  });
}

// ── Input field renderer ──

function InputField({
  inp,
  value,
  profileNames,
  onChange,
}: {
  inp: MoveInput;
  value: string;
  profileNames: string[];
  onChange: (v: string) => void;
}) {
  const label = inp.label ?? inp.name;
  const options = selectOptions(inp, profileNames);
  const isToggle = inp.type === "toggle";
  const isSelect = inp.type === "select" && options.length > 0;

  if (isSelect) {
    const current = value || stringifyDefault(inp.default) || options[0] || "";
    return (
      <div className="moves-input-field">
        <label className="moves-input-label">
          {label}
          {inp.required && <span className="moves-input-required">*</span>}
        </label>
        <select
          className="moves-input-control"
          value={current}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
    );
  }

  if (isToggle) {
    const checked = (value || stringifyDefault(inp.default) || "no") === "yes";
    return (
      <div className="moves-input-field">
        <label className="moves-input-toggle">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <span>{label}</span>
        </label>
      </div>
    );
  }

  if (inp.type === "textarea") {
    return (
      <div className="moves-input-field">
        <label className="moves-input-label">
          {label}
          {inp.required && <span className="moves-input-required">*</span>}
        </label>
        <textarea
          className="moves-input-control moves-input-textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={inp.placeholder}
          rows={3}
        />
      </div>
    );
  }

  return (
    <div className="moves-input-field">
      <label className="moves-input-label">
        {label}
        {inp.required && <span className="moves-input-required">*</span>}
      </label>
      <input
        className="moves-input-control"
        type={inp.type === "number" ? "number" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={inp.placeholder}
      />
    </div>
  );
}

// ── Expanded move detail ──

function MoveDetail({
  move,
  profileNames,
  onAttach,
  onClose,
  busy,
  error,
}: {
  move: MoveListItem;
  profileNames: string[];
  onAttach: (inputs: Record<string, string>) => void;
  onClose: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const inp of move.inputs ?? []) {
      init[inp.name] = stringifyDefault(inp.default);
    }
    return init;
  });

  const hasInputs = (move.inputs ?? []).length > 0;
  const ready = !hasInputs || isMoveInputReady(move, values, profileNames);
  const Icon = resolveIcon(move.icon);

  return (
    <div className="moves-detail">
      <div className="moves-detail-header">
        <div className="moves-detail-title">
          {Icon && <Icon size={14} strokeWidth={1.5} className="moves-tile-icon" />}
          <span>{move.label}</span>
        </div>
        <button className="moves-detail-close" onClick={onClose}>×</button>
      </div>
      {move.description && (
        <div className="moves-detail-desc">{move.description}</div>
      )}
      {hasInputs && (move.inputs ?? []).map((inp) => (
        <InputField
          key={inp.name}
          inp={inp}
          value={values[inp.name] ?? ""}
          profileNames={profileNames}
          onChange={(v) => setValues((prev) => ({ ...prev, [inp.name]: v }))}
        />
      ))}
      {error && <div className="moves-widget-error">{error}</div>}
      <div className="moves-input-actions">
        <button
          className="moves-input-btn moves-input-btn--submit"
          disabled={!ready || busy}
          onClick={() => onAttach(values)}
        >
          {busy ? "attaching..." : "attach"}
        </button>
      </div>
    </div>
  );
}

// ── Main widget ──

function MovesWidget(_props: WidgetProps) {
  const { activeCwd, activeUserProfile, profiles, activeUP } = useProfiles();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const profileNames = (() => {
    const names = activeUP?.agentProfiles?.length
      ? activeUP.agentProfiles
      : profiles.map((p) => p.name);
    return ["Current profile", ...names];
  })();

  const loadMoves = useCallback(
    () => (activeCwd ? fetchMoves(activeCwd) : Promise.resolve([])),
    [activeCwd],
  );

  const { value: moves, loading } = useWidgetPollingValue<MoveListItem[]>({
    load: loadMoves,
    scopeKey: activeCwd ?? "",
    intervalMs: 60_000,
    initialValue: [],
  });

  const doAttach = (move: MoveListItem, rawValues: Record<string, string>) => {
    const inputs = buildMoveInputs(move, rawValues, profileNames);
    // Dispatch to ChatInput — it handles all attach paths:
    // mountOnAttach widgets, regular composer chips, persistent moves
    window.dispatchEvent(new CustomEvent("modus:attach-move", {
      detail: { move, inputs },
    }));
    setExpanded(null);
    setError(null);
  };

  if (!activeCwd) {
    return <WidgetEmptyState>no project selected</WidgetEmptyState>;
  }
  if (loading && moves.length === 0) {
    return <WidgetEmptyState>loading moves...</WidgetEmptyState>;
  }
  if (moves.length === 0) {
    return <WidgetEmptyState>no moves available</WidgetEmptyState>;
  }

  const expandedMove = expanded ? moves.find((m) => m.name === expanded) : null;

  if (expandedMove) {
    return (
      <div className="moves-widget">
        <MoveDetail
          move={expandedMove}
          profileNames={profileNames}
          onAttach={(values) => doAttach(expandedMove, values)}
          onClose={() => { setExpanded(null); setError(null); }}
          busy={false}
          error={error}
        />
      </div>
    );
  }

  const q = search.toLowerCase().trim();
  const filtered = q
    ? moves.filter((m) =>
        m.label.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.tags?.some((t) => t.toLowerCase().includes(q))
      )
    : moves;

  return (
    <div className="moves-widget">
      {error && <div className="moves-widget-error">{error}</div>}
      <input
        className="moves-search"
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="filter moves..."
        spellCheck={false}
      />
      <div className="moves-grid">
        {filtered.map((m) => {
          const Icon = resolveIcon(m.icon);
          return (
            <button
              key={m.name}
              className="moves-tile"
              onClick={() => setExpanded(m.name)}
              title={m.description}
            >
              {Icon
                ? <Icon size={14} strokeWidth={1.5} className="moves-tile-icon" />
                : <span className="moves-tile-icon moves-tile-icon--letter">{m.label[0]}</span>
              }
              <span className="moves-tile-label">{m.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const def: WidgetDef = { type: "moves", component: MovesWidget };
export default def;
