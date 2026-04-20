import { useState } from "react";
import { estimateTokens } from "../utils/tokens";

interface Props {
  text: string;
  onRemove?: () => void;
  onInline?: () => void;
}

export function PasteBlock({ text, onRemove, onInline }: Props) {
  const [expanded, setExpanded] = useState(false);
  const meta = `pasted · ${estimateTokens(text)}`;

  return (
    <div className={`paste-block ${expanded ? "expanded" : ""}`}>
      <div
        className="paste-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="paste-caret" aria-hidden="true">
          {expanded ? "▾" : "▸"}
        </span>
        <span className="paste-meta">{meta}</span>
        {onInline && (
          <button
            className="paste-btn"
            onClick={(e) => { e.stopPropagation(); onInline(); }}
            title="Insert as plain text"
          >
            as text
          </button>
        )}
        {onRemove && (
          <button
            className="paste-btn paste-btn-x"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            title="Remove"
          >
            &times;
          </button>
        )}
      </div>
      {expanded && (
        <div className="paste-text">{text}</div>
      )}
    </div>
  );
}
