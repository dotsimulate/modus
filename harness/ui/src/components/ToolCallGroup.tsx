import { useState, type ReactNode } from "react";

/**
 * A run of consecutive tool calls, collapsed behind one header.
 *
 * The same component renders a run whether its payload is in hand or still on
 * the server. That is the point: a forty-call run looked completely different
 * live (forty rows) and after a reload (a "load 40 tool calls" button), and the
 * button implied the count was the *action* when it was really the transport
 * state leaking through. Here the header is identical either way — expanding is
 * what differs, and for a deferred run expanding happens to fetch first.
 */

/** Runs shorter than this stay flat; grouping them would only add a click. */
export const TOOL_RUN_GROUP_MIN = 5;

/** "24 Read · 11 Edit · 5 Bash", heaviest first, capped so the header stays one line. */
export function formatToolTally(toolNames: Record<string, number>): string {
  return Object.entries(toolNames)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([name, count]) => `${count} ${name}`)
    .join(" · ");
}

type Props = {
  /** Keep the same subtree while showing ungrouped rows during streaming. */
  inline?: boolean;
  count: number;
  toolNames: Record<string, number>;
  hasThinking?: boolean;
  /** Payload is still on the server; expanding fetches it first. */
  deferred?: boolean;
  loading?: boolean;
  error?: string;
  onLoad?: () => void | Promise<void>;
  children?: ReactNode;
};

export function ToolCallGroup({
  inline = false,
  count,
  toolNames,
  hasThinking = false,
  deferred = false,
  loading = false,
  error,
  onLoad,
  children,
}: Props) {
  // A run first seen live stays open when its collapse header appears.
  const [expanded, setExpanded] = useState(inline);
  const tally = formatToolTally(toolNames);
  const label = count > 0
    ? `${count} tool call${count === 1 ? "" : "s"}`
    : hasThinking ? "thinking" : "details";

  // A deferred group that has been asked to load stays "expanded" so the
  // arriving content appears in place rather than needing a second click.
  const open = inline || (expanded && (!deferred || !loading));
  const inlineStyle = inline ? { display: "contents" } : undefined;

  const toggle = () => {
    if (deferred && !expanded && onLoad) void onLoad();
    setExpanded((prev) => !prev);
  };

  return (
    <div style={inlineStyle} className={`tool-run${open ? " tool-run--open" : ""}${deferred ? " tool-run--deferred" : ""}`}>
      <button type="button" style={inline ? { display: "none" } : undefined} className="tool-run-header" onClick={toggle} aria-expanded={open}>
        <svg className="tool-run-chevron" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        <span className="tool-run-label">{label}</span>
        {hasThinking && count > 0 && <span className="tool-run-thinking">+ thinking</span>}
        {tally && <span className="tool-run-tally">{tally}</span>}
        {loading && <span className="tool-run-state">loading…</span>}
        {!loading && error && <span className="tool-run-state tool-run-state--error">{error}</span>}
        {!loading && !error && deferred && <span className="tool-run-state">not loaded</span>}
      </button>
      <div style={inlineStyle} className={`tool-run-collapse${open ? " tool-run-collapse--open" : ""}`}>
        <div style={inlineStyle} className="tool-run-clip">
          <div style={inlineStyle} className="tool-run-body">{children}</div>
        </div>
      </div>
    </div>
  );
}
