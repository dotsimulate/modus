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
import { useWidgetUiState } from "./ui-state";
import type { LucideIcon } from "lucide-react";
import { type ComponentType, useState as _useState, useEffect as _useEffect } from "react";

// ── Icon resolution (lazy) ──
// Dynamically import individual icons to avoid pulling the entire 46MB lucide-react barrel.

const iconCache = new Map<string, ComponentType<{ size?: number; strokeWidth?: number }>>();

function resolveIcon(name?: string): LucideIcon | null {
  if (!name) return null;
  const pascal = name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
  return (iconCache.get(pascal) as LucideIcon) ?? null;
}

function useIcon(name?: string): LucideIcon | null {
  const [icon, setIcon] = _useState<LucideIcon | null>(() => resolveIcon(name));
  _useEffect(() => {
    if (!name) return;
    const pascal = name
      .split("-")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join("");
    if (iconCache.has(pascal)) { setIcon(iconCache.get(pascal) as LucideIcon); return; }
    import("lucide-react").then((mod) => {
      const comp = (mod as Record<string, unknown>)[pascal] as LucideIcon | undefined;
      if (comp) { iconCache.set(pascal, comp); setIcon(comp); }
    }).catch(() => {});
  }, [name]);
  return icon;
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
  const Icon = useIcon(move.icon);

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

// ── Group helpers ──

type MoveGroup = { key: string; label: string; moves: MoveListItem[] };
const EMPTY_SELECTED_TAGS: string[] = [];

function classifyMove(m: MoveListItem): "mine" | "other" {
  const tags = m.tags ?? [];
  if (tags.includes("factory-v2") || tags.includes("factory-r1")) return "other";
  return "mine";
}

function collectTags(moves: MoveListItem[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const move of moves) {
    for (const tag of move.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

function orderTagOptions(
  tags: Array<{ tag: string; count: number }>,
  selectedTags: string[],
): Array<{ tag: string; count: number }> {
  const selected = selectedTags
    .map((tag) => tags.find((entry) => entry.tag === tag))
    .filter((entry): entry is { tag: string; count: number } => !!entry);
  const rest = tags.filter((entry) => !selectedTags.includes(entry.tag));
  return [...selected, ...rest];
}

function groupMoves(moves: MoveListItem[], selectedTags: string[]): MoveGroup[] {
  const buckets: Record<"mine" | "other", MoveListItem[]> = { mine: [], other: [] };
  for (const m of moves) buckets[classifyMove(m)].push(m);

  const groups: MoveGroup[] = [];
  if (buckets.mine.length) groups.push({ key: "mine", label: "mine", moves: buckets.mine });

  const remaining = [...buckets.other];
  for (const tag of selectedTags) {
    const tagged = remaining.filter((move) => move.tags?.includes(tag));
    if (!tagged.length) continue;
    groups.push({ key: `tag:${tag}`, label: `#${tag}`, moves: tagged });
    for (const move of tagged) {
      const idx = remaining.indexOf(move);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  if (remaining.length) {
    groups.push({
      key: "other",
      label: groups.length === 0 ? "moves" : selectedTags.length > 0 ? "everything else" : "others",
      moves: remaining,
    });
  }

  return groups;
}

function TagGroupsControl({
  availableTags,
  selectedTags,
  open,
  onToggleOpen,
  onToggleTag,
}: {
  availableTags: Array<{ tag: string; count: number }>;
  selectedTags: string[];
  open: boolean;
  onToggleOpen: () => void;
  onToggleTag: (tag: string) => void;
}) {
  const selectedCount = selectedTags.length;

  return (
    <div className="moves-tag-groups">
      <button type="button" className="moves-tag-groups-header" onClick={onToggleOpen}>
        <span className={`moves-group-chevron${open ? " moves-group-chevron--open" : ""}`}>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
            <path d="M2 1l4 3-4 3z" />
          </svg>
        </span>
        <span className="moves-tag-groups-label">tag groups</span>
        <span className="moves-tag-groups-summary">
          {selectedCount > 0 ? `${selectedCount} selected` : "none selected"}
        </span>
      </button>
      <div className={`moves-expand${open ? " moves-expand--open" : ""}`}>
        <div className="moves-expand-clip">
          <div className="moves-tag-groups-body">
            {availableTags.length === 0 ? (
              <div className="moves-tag-groups-empty">no tags in this view</div>
            ) : (
              <div className="moves-tag-list">
                {availableTags.map(({ tag, count }) => {
                  const active = selectedTags.includes(tag);
                  return (
                    <button
                      type="button"
                      key={tag}
                      className={`moves-tag-row${active ? " moves-tag-row--active" : ""}`}
                      onClick={() => onToggleTag(tag)}
                    >
                      <span className="moves-tag-row-name">{tag}</span>
                      <span className="moves-tag-row-count">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Collapsible group header ──

function GroupHeader({
  label,
  count,
  collapsed,
  onToggle,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="moves-group-header" onClick={onToggle}>
      <span className={`moves-group-chevron${collapsed ? "" : " moves-group-chevron--open"}`}>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path d="M2 1l4 3-4 3z" />
        </svg>
      </span>
      <span className="moves-group-label">{label}</span>
      <span className="moves-group-count">{count}</span>
    </button>
  );
}

// ── Main widget ──

function MovesWidget({ widgetId }: WidgetProps) {
  const { activeCwd, activeUserProfile, profiles, activeUP } = useProfiles();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [tagGroupsOpen, setTagGroupsOpen] = useWidgetUiState<boolean>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "tag-groups-open",
    false,
  );
  const [selectedTags, setSelectedTags] = useWidgetUiState<string[]>(
    { userProfile: activeUserProfile, cwd: activeCwd },
    widgetId,
    "selected-tags",
    EMPTY_SELECTED_TAGS,
  );

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

  const availableTags = orderTagOptions(
    collectTags(filtered.length > 0 ? filtered : moves),
    selectedTags,
  );
  const isSearching = q.length > 0;
  const groups = groupMoves(filtered, selectedTags);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) => (
      prev.includes(tag)
        ? prev.filter((t) => t !== tag)
        : [...prev, tag]
    ));
  };

  return (
    <div className="moves-widget">
      {error && <div className="moves-widget-error">{error}</div>}
      {moves.length > 5 && (
        <div className="moves-search-wrap">
          {search && (
            <button
              type="button"
              className="moves-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
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
      <TagGroupsControl
        availableTags={availableTags}
        selectedTags={selectedTags}
        open={tagGroupsOpen}
        onToggleOpen={() => setTagGroupsOpen((v) => !v)}
        onToggleTag={toggleTag}
      />
      <div className="moves-list">
        {groups.map((g) => {
          const isCollapsed = !isSearching && !!collapsed[g.key];
          return (
            <div key={g.key} className="moves-group">
              <GroupHeader
                label={g.label}
                count={g.moves.length}
                collapsed={isCollapsed}
                onToggle={() =>
                  setCollapsed((prev) => ({ ...prev, [g.key]: !prev[g.key] }))
                }
              />
              {!isCollapsed && g.moves.map((m) => (
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
          );
        })}
      </div>
    </div>
  );
}

const def: WidgetDef = { type: "moves", component: MovesWidget };
export default def;
