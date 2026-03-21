export type InlineTabOption<T extends string> = {
  value: T;
  label: string;
};

export function InlineTabs<T extends string>({
  options,
  value,
  onChange,
  size = "md",
}: {
  options: InlineTabOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  return (
    <div className={`itabs itabs--${size}`}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`itabs-tab ${value === option.value ? "itabs-tab--active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
