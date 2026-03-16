/**
 * CopyButton — reusable copy-to-clipboard button with auto-reset feedback.
 *
 * Manages its own copied state. Shows clipboard icon → check icon on copy,
 * resets after 1s. Supports static `value` or async `getValue` for lazy fetch.
 */

import { useState, useEffect, useCallback } from "react";

type Props = {
  /** Static text to copy */
  value?: string;
  /** Async getter — used when content needs to be fetched on click */
  getValue?: () => Promise<string | null>;
  size?: "default" | "inline";
  title?: string;
};

export function CopyButton({ value, getValue, size = "default", title }: Props) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1000);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = useCallback(async () => {
    try {
      const text = value ?? (getValue ? await getValue() : null);
      if (text !== null && text !== undefined) {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }
    } catch { /* clipboard access denied — silent */ }
  }, [value, getValue]);

  const sizeClass = size === "inline" ? " chat-file-viewer-btn--inline" : "";

  return (
    <button
      className={`chat-file-viewer-btn${sizeClass}${copied ? " is-copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : (title ?? "Copy")}
    >
      {copied ? (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><path d="M2.2 6.4 4.6 8.8 9.8 3.6" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"/></svg>
      ) : (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="4.25" y="2.25" width="5.5" height="7.5" rx="0.9" stroke="currentColor" strokeWidth="1.1"/><path d="M2.25 8V3.1c0-.5.4-.85.9-.85h3.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
      )}
    </button>
  );
}
