import type { KeyboardEventHandler, ReactNode, Ref } from "react";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  placeholder?: string;
  rows?: number;
  submitLabel?: string;
  leftSlot?: ReactNode;
  compact?: boolean;
  textareaRef?: Ref<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
};

export function PromptComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  submitDisabled,
  placeholder,
  rows = 4,
  submitLabel = "run",
  leftSlot,
  compact = false,
  textareaRef,
  onKeyDown,
}: Props) {
  return (
    <div className={`prompt-composer${compact ? " prompt-composer--compact" : ""}`}>
      <textarea
        ref={textareaRef}
        className="prompt-composer-textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        disabled={disabled}
      />
      {leftSlot && (
        <div className="prompt-composer-left">
          {leftSlot}
        </div>
      )}
      <button
        className="prompt-composer-submit"
        type="button"
        onClick={onSubmit}
        disabled={submitDisabled}
      >
        {submitLabel}
      </button>
    </div>
  );
}
