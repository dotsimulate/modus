export function DateTimeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="dtf-field">
      <span className="dtf-label">{label}</span>
      <span className="dtf-control">
        <input
          className="dtf-input"
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </label>
  );
}
