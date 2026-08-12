/** Shared formatting utilities for widgets and components. */

/** crypto.randomUUID() only works in secure contexts (HTTPS/localhost).
 *  This fallback uses crypto.getRandomValues() which works everywhere. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function fmtCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function basename(path: string | null | undefined): string {
  if (!path || path === "(none)") return path ?? "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/**
 * The fields any session-shaped record needs to produce a display label.
 * Structural so both SessionInfo and FileSessionRef can be labelled the same way.
 */
export type SessionLabelFields = {
  title?: string | null;
  last_prompt?: string | null;
  preview?: string | null;
};

/** A complete move block: opener, body, matching closer. */
const MOVE_BLOCK = /<!--\s*move:([\w.-]+)\s*-->[\s\S]*?<!--\s*\/move:\1\s*-->/g;
/** An opener with no closer — everything after it is preamble. */
const MOVE_OPENER = /^\s*<!--\s*move:([\w.-]+)\s*-->/;

/**
 * Strips move-injected preamble out of a session label.
 *
 * `sessions.last_prompt` and `sessions.preview` are stored truncated to 80
 * characters, so for a session launched inside a move the entire stored value is
 * the move's injected header and the user's own text is not present at all.
 * Roughly 44% of sessions are in this state. Rendering the raw value shows
 * "<!-- move:modus-brain --> You are inside the..." as the title, and for moves
 * that inject a token it puts that token in the label. Naming the move is both
 * more useful and less leaky than showing the fragment.
 */
function stripMovePreamble(text: string): string {
  const withoutBlocks = text.replace(MOVE_BLOCK, " ").trim();
  if (withoutBlocks) {
    const truncated = withoutBlocks.match(MOVE_OPENER);
    return truncated ? `${truncated[1]} move` : withoutBlocks;
  }
  const opener = text.match(/<!--\s*move:([\w.-]+)\s*-->/);
  return opener ? `${opener[1]} move` : "";
}

/**
 * Label for a session row. `preview` is the last fallback on purpose: for a
 * session started inside a move it holds the injected move preamble rather than
 * anything the user typed, so title and last_prompt both come first. A
 * user-set title is authoritative and is never rewritten.
 */
export function sessionDisplayText(s: SessionLabelFields): string {
  if (s.title) return s.title;
  return stripMovePreamble(s.last_prompt || s.preview || "");
}

export function isEmptySession(s: SessionLabelFields): boolean {
  return !s.title && !s.last_prompt && !s.preview;
}

export function compactModelName(model: string): string {
  // Strip date suffixes like -20251101
  let m = model.replace(/-\d{8}$/, "");
  // Common shorthands
  if (m.startsWith("claude-")) m = m.replace("claude-", "");
  if (m.startsWith("gpt-")) return m;
  if (m.startsWith("gemini-")) m = m.replace("gemini-", "");
  return m;
}

export function planLabel(sub: string): string {
  switch (sub) {
    case "max": return "Max";
    case "pro": return "Pro";
    case "free": return "Free";
    case "team": return "Team";
    case "enterprise": return "Enterprise";
    default: return sub;
  }
}
