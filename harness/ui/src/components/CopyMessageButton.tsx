import { useState, useRef, useCallback } from "react";
import type { Message } from "../../../sdk/index";
import { buildCopyText, type CopyMode } from "../message-copy";

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5V3.5C10.5 2.67 9.83 2 9 2H3.5C2.67 2 2 2.67 2 3.5V9C2 9.83 2.67 10.5 3.5 10.5H5.5" />
  </svg>
);

export function CopyMessageButton({ msg }: { msg: Message }) {
  const [copied, setCopied] = useState<CopyMode | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const doCopy = useCallback((mode: CopyMode) => {
    const text = buildCopyText(msg, mode);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(mode);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(null), 1200);
    });
  }, [msg]);

  return (
    <div className="msg-copy">
      <button className="msg-copy-btn" onClick={() => doCopy("last")}>
        {copied ? <span className="msg-copy-check">✓</span> : <CopyIcon />}
      </button>
      <div className="msg-copy-menu">
        <div className="msg-copy-menu-inner">
          <button className="msg-copy-item" onClick={() => doCopy("full")}>
            <span className="msg-copy-label">+ all</span>
            {copied === "full" && <span className="msg-copy-check">✓</span>}
          </button>
          <button className="msg-copy-item" onClick={() => doCopy("thinking")}>
            <span className="msg-copy-label">+ thinking</span>
            {copied === "thinking" && <span className="msg-copy-check">✓</span>}
          </button>
          <button className="msg-copy-item" onClick={() => doCopy("text")}>
            <span className="msg-copy-label">response</span>
            {copied === "text" && <span className="msg-copy-check">✓</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
