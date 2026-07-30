import { useState } from "react";
import type { QueuedMessage as QueuedMessageType } from "../providers/SessionContext";
import type { MoveListItem } from "../../../sdk/index";

type Props = {
  message: QueuedMessageType;
  onCancel: () => void;
};

export function QueuedMessage({ message, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hasImages = message.attachments.length > 0;
  const preview = message.text.length > 60
    ? message.text.slice(0, 60) + "..."
    : message.text;

  // The point of this strip is that the message has *not* been delivered yet.
  // Say why, since the reason differs: an ordinary send always waits for the
  // turn, while a declined interjection waits because the provider cannot
  // deliver mid-turn at all.
  const title = message.steerDeclined
    ? "This provider cannot deliver mid-turn — sends when the current turn ends"
    : "Sends when the current turn ends";

  return (
    <div className="queued-message" title={title}>
      <div className="queued-message-header" onClick={() => setExpanded(!expanded)}>
        <span className="queued-message-indicator">
          <span className="queued-message-dot" />
        </span>
        <span className="queued-message-label">
          {message.steerDeclined ? "queued · can't interject" : "queued"}
        </span>
        <span className="queued-message-preview">
          {hasImages && `[${message.attachments.length} img] `}
          {preview}
        </span>
        <button className="queued-message-cancel" onClick={(e) => { e.stopPropagation(); onCancel(); }}>
          cancel
        </button>
      </div>
      {expanded && (
        <div className="queued-message-body">
          {message.text}
        </div>
      )}
    </div>
  );
}

type AttachedWidgetContentProps = {
  label: string;
  moveName: string;
  onDetach: () => void;
};

export function AttachedWidgetContent({ label, moveName, onDetach }: AttachedWidgetContentProps) {
  return (
    <div className="queued-message queued-message--move">
      <div className="queued-message-header">
        <span className="queued-message-indicator">
          <span className="queued-message-dot" />
        </span>
        <span className="queued-message-label">{moveName}</span>
        <span className="queued-message-preview">{label}</span>
        <button className="queued-message-cancel" onClick={onDetach}>
          detach
        </button>
      </div>
    </div>
  );
}

type AttachedMoveProps = {
  move: MoveListItem;
  inputs?: Record<string, unknown>;
  onDetach: () => void;
};

export function AttachedMove({ move, inputs, onDetach }: AttachedMoveProps) {
  const filledInputs = (move.inputs ?? []).filter((inp) => {
    const val = inputs?.[inp.name];
    return val !== undefined && val !== "" && String(val) !== String(inp.default ?? "");
  });

  return (
    <div className="queued-message queued-message--move">
      <div className="queued-message-header">
        <span className="queued-message-indicator">
          <span className="queued-message-dot" />
        </span>
        <span className="queued-message-label">move</span>
        <span className="queued-message-preview">
          {move.label}
          {filledInputs.map((inp) => (
            <span key={inp.name} className="queued-message-move-input">
              {" · "}{String(inputs![inp.name])}
            </span>
          ))}
        </span>
        <button className="queued-message-cancel" onClick={onDetach}>
          detach
        </button>
      </div>
    </div>
  );
}
