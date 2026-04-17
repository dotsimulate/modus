import { useEffect, useMemo, useRef, useState } from "react";

type SearchDropdownOption = {
  value: string;
  label?: string;
};

type Props = {
  value: string;
  options: SearchDropdownOption[];
  placeholder: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  clearable?: boolean;
  allowCustom?: boolean;
  onChange: (value: string) => void;
};

export function SearchDropdown({
  value,
  options,
  placeholder,
  searchPlaceholder = "search...",
  emptyLabel = "no matches",
  disabled,
  className = "",
  clearable = true,
  allowCustom = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((option) => option.value === value);
  const selectedLabel = selected?.label ?? selected?.value ?? (allowCustom ? value : "");

  useEffect(() => {
    if (open) return;
    setQuery(selectedLabel);
  }, [open, selectedLabel]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => {
      const label = option.label ?? option.value;
      return label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle);
    });
  }, [options, query]);

  const openMenu = () => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
  };

  const closeMenu = () => {
    setOpen(false);
    setQuery(selectedLabel);
  };

  const selectOption = (nextValue: string) => {
    const next = options.find((option) => option.value === nextValue);
    onChange(nextValue);
    setQuery(next?.label ?? next?.value ?? "");
    setOpen(false);
  };

  const clearSelection = () => {
    onChange("");
    setQuery("");
    setOpen(false);
    inputRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`search-dropdown${open ? " search-dropdown--open" : ""}${disabled ? " search-dropdown--disabled" : ""}${className ? ` ${className}` : ""}`}
    >
      <div className="search-dropdown-control">
        <input
          ref={inputRef}
          className="search-dropdown-input"
          value={open ? query : selectedLabel}
          placeholder={open ? searchPlaceholder : placeholder}
          disabled={disabled}
          onFocus={openMenu}
          onChange={(e) => {
            if (!open) setOpen(true);
            setQuery(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openMenu();
              return;
            }
            if (e.key === "Enter" && open) {
              e.preventDefault();
              if (filteredOptions.length > 0) {
                selectOption(filteredOptions[0].value);
              } else if (allowCustom && query.trim()) {
                onChange(query.trim());
                setOpen(false);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenu();
              inputRef.current?.blur();
            }
          }}
        />
        <button
          type="button"
          className="search-dropdown-toggle"
          aria-label={value && clearable ? "clear selection" : open ? "close options" : "open options"}
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (value && clearable) {
              clearSelection();
              return;
            }
            if (open) closeMenu();
            else openMenu();
          }}
        >
          {value && clearable ? (
            <span className="search-dropdown-toggle-x">&times;</span>
          ) : (
            <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
              <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>

      {open && (
        <div className="search-dropdown-menu">
          {filteredOptions.length === 0 ? (
            <div className="search-dropdown-empty">{allowCustom && query.trim() ? `press enter to use "${query.trim()}"` : emptyLabel}</div>
          ) : (
            filteredOptions.map((option) => {
              const label = option.label ?? option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`search-dropdown-item${option.value === value ? " search-dropdown-item--active" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectOption(option.value)}
                >
                  {label}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
