import { useState, useRef, useEffect } from "react";
import { WIDGET_DEFS, WIDGETS, type WidgetBase, type WidgetSize, type WidgetZone } from "../widgets";

type Zone = WidgetZone;

type Props = {
  zone: Zone;
  /** Currently active widgets in this zone */
  current: WidgetBase[];
  /** Called with the updated widget list when user adds/removes/reorders */
  onChange: (widgets: WidgetBase[]) => void;
  mode?: "list" | "tabs";
  onModeChange?: (mode: "list" | "tabs") => void;
};

const sizeOptions: { value: WidgetSize; label: string }[] = [
  { value: "full", label: "full" },
  { value: "half", label: "half" },
];

const zoneEnabled = (type: string, zone: Zone) => {
  const def = WIDGET_DEFS[type];
  const zones = def?.zones ?? ["dashboard", "left-panel", "right-panel"];
  return zones.includes(zone);
};

const allTypes = (zone: Zone) => Object.keys(WIDGETS).filter((type) => zoneEnabled(type, zone)).sort();

export function WidgetPicker({ zone, current, onChange, mode, onModeChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open]);

  const currentTypes = new Set(current.map((w) => w.type));
  const types = [
    ...current.map((w) => w.type).filter((type, index, arr) => zoneEnabled(type, zone) && arr.indexOf(type) === index),
    ...allTypes(zone).filter((type) => !currentTypes.has(type)),
  ];

  const toggle = (type: string) => {
    if (currentTypes.has(type)) {
      onChange(current.filter((w) => w.type !== type));
    } else {
      const newWidget: WidgetBase = {
        id: `${zone}-${type}-${Date.now()}`,
        type,
        size: zone === "dashboard" ? "full" : undefined,
      };
      onChange([...current, newWidget]);
    }
  };

  const setSize = (type: string, size: WidgetSize) => {
    onChange(current.map((w) => w.type === type ? { ...w, size } : w));
  };

  const moveUp = (type: string) => {
    const idx = current.findIndex((w) => w.type === type);
    if (idx <= 0) return;
    const next = [...current];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    onChange(next);
  };

  const moveDown = (type: string) => {
    const idx = current.findIndex((w) => w.type === type);
    if (idx < 0 || idx >= current.length - 1) return;
    const next = [...current];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    onChange(next);
  };

  return (
    <div className="widget-picker" ref={ref}>
      <button
        className="widget-picker-trigger"
        onClick={() => setOpen(!open)}
        title="Add or remove widgets"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="widget-picker-dropdown">
          <div className="widget-picker-header">widgets</div>
          {onModeChange && (
            <div className="widget-picker-modes">
              <button
                className={`widget-picker-mode${mode === "tabs" ? " widget-picker-mode--active" : ""}`}
                onClick={() => onModeChange("tabs")}
              >
                tabs
              </button>
              <button
                className={`widget-picker-mode${mode === "list" ? " widget-picker-mode--active" : ""}`}
                onClick={() => onModeChange("list")}
              >
                list
              </button>
            </div>
          )}
          <div className="widget-picker-list">
            {types.map((type) => {
              const active = currentTypes.has(type);
              return (
                <div key={type} className={`widget-picker-item${active ? " widget-picker-item--active" : ""}`}>
                  <button
                    className="widget-picker-item-toggle"
                    onClick={() => toggle(type)}
                  >
                    <span className="widget-picker-check">{active ? "×" : "+"}</span>
                    <span className="widget-picker-item-name">{type}</span>
                  </button>

                  {active && (
                    <span className="widget-picker-item-controls">
                      {zone === "dashboard" && (
                        <select
                          className="widget-picker-size-select"
                          value={current.find((w) => w.type === type)?.size ?? "full"}
                          onChange={(e) => setSize(type, e.target.value as WidgetSize)}
                        >
                          {sizeOptions.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      )}
                      <button className="widget-picker-move" onClick={() => moveUp(type)} title="Move up">↑</button>
                      <button className="widget-picker-move" onClick={() => moveDown(type)} title="Move down">↓</button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
