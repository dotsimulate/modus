/**
 * Moves widget — compact list of available moves with inline expand.
 *
 * Harness-level widget: always available on dashboard or left panel.
 * Click a row to expand it inline: shows description, inputs (if any),
 * and an "attach" button. Uses CSS grid collapse (0fr/1fr) for expand.
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

// ── Inline detail (expanded under a row) ──

function MoveDetail({
  move,
  profileNames,
  onAttach,
  busy,
  error,
}: {
  move: MoveListItem;
  profileNames: string[];
  onAttach: (inputs: Record<string, string>) => void;
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

  // Button label reflects what actually happens
  const isWidgetOnly = !!move.widget?.mountOnAttach;
  const isPersistent = !!move.persistent;
  const actionLabel = isWidgetOnly ? "open widget"
    : isPersistent ? "enable"
    : "attach";
  const busyLabel = isWidgetOnly ? "opening..."
    : isPersistent ? "enabling..."
    : "attaching...";
  // Hint for moves that will send a message to the LLM
  const sendsMessage = !isWidgetOnly && !isPersistent;

  return (
    <div className="moves-detail">
      {move.description && (
        <div className="moves-detail-desc">{move.description}</div>
      )}
      {move.tags && move.tags.length > 0 && (
        <div className="moves-detail-tags">
          {move.tags.map((t) => (
            <span key={t} className="moves-detail-tag">{t}</span>
          ))}
        </div>
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
          {busy ? busyLabel : actionLabel}
        </button>
        {sendsMessage && (
          <span className="moves-action-hint">sends to chat</span>
        )}
      </div>
    </div>
  );
}

// ── Single move row with inline expand ──

function MoveRow({
  move,
  expanded,
  profileNames,
  onToggle,
  onAttach,
  error,
}: {
  move: MoveListItem;
  expanded: boolean;
  profileNames: string[];
  onToggle: () => void;
  onAttach: (move: MoveListItem, values: Record<string, string>) => void;
  error: string | null;
}) {
  const Icon = resolveIcon(move.icon);

  return (
    <>
      <button
        className={`moves-row${expanded ? " moves-row--expanded" : ""}`}
        onClick={onToggle}
      >
        <span className="moves-row-icon">
          {Icon
            ? <Icon size={12} strokeWidth={1.5} />
            : <span className="moves-row-icon--letter">{move.label[0]}</span>
          }
        </span>
        <span className="moves-row-label">{move.label}</span>
      </button>
      <div className={`moves-expand${expanded ? " moves-expand--open" : ""}`}>
        <div className="moves-expand-clip">
          {expanded && (
            <MoveDetail
              move={move}
              profileNames={profileNames}
              onAttach={(values) => onAttach(move, values)}
              busy={false}
              error={error}
            />
          )}
        </div>
      </div>
    </>
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
      {moves.length > 5 && (
        <div className="moves-search-wrap">
          {search && (
            <button
              className="moves-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <icons.X size={10} strokeWidth={2} />
            </button>
          )}
          <input
            className="moves-search"
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search..."
            spellCheck={false}
          />
        </div>
      )}
      <div className="moves-list">
        {filtered.map((m) => (
          <MoveRow
            key={m.name}
            move={m}
            expanded={expanded === m.name}
            profileNames={profileNames}
            onToggle={() => setExpanded(expanded === m.name ? null : m.name)}
            onAttach={doAttach}
            error={expanded === m.name ? error : null}
          />
        ))}
      </div>
    </div>
  );
}

const def: WidgetDef = { type: "moves", component: MovesWidget };
export default def;
