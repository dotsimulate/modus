import { useEffect, useRef, useState } from "react";

export type SelectOption = { value: string; label: string };

export function CustomSelect({
  options,
  value,
  placeholder = "select…",
  disabled,
  onChange,
}: {
  options: SelectOption[];
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className={`csel${open ? " csel--open" : ""}`} ref={ref}>
      <button
        className="csel-trigger"
        disabled={disabled}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className={selected ? "csel-value" : "csel-placeholder"}>
          {selected?.label ?? placeholder}
        </span>
        <span className="csel-chevron">›</span>
      </button>
      {open && (
        <div className="csel-dropdown">
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`csel-option${opt.value === value ? " csel-option--active" : ""}`}
              type="button"
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
