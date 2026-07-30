/**
 * Pure path helpers for the FolderPicker.
 *
 * The picker navigates the *server's* filesystem, which may use either
 * separator, so nothing here may assume the client's platform. Kept separate
 * from the component because the UI has no DOM test environment — this is the
 * part worth pinning.
 */

/** Windows device names that cannot be used as a file or folder name. */
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Characters Windows rejects outright. Spaces are legal and stay legal. */
const ILLEGAL_CHARS = /[<>:"|?*]/;

/** Control characters, tested by code point so the source carries no escapes. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32 || s.charCodeAt(i) === 127) return true;
  }
  return false;
}

export type FolderNameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validates a new folder name against the directory currently listed.
 *
 * `siblings` comes from the browse result, so the "already exists" case is
 * answered without a round trip. The comparison is case-insensitive: every
 * platform Modus ships an interactive picker on (Windows, macOS) treats names
 * that way, and a false collision is a better outcome than a confusing EEXIST.
 */
export function validateFolderName(raw: string, siblings: string[] = []): FolderNameCheck {
  const name = raw.trim();
  if (!name) return { ok: false, error: "name required" };
  if (/[/\\]/.test(name)) return { ok: false, error: "no slashes — this creates one folder here" };
  if (name === "." || name === "..") return { ok: false, error: "invalid name" };
  if (ILLEGAL_CHARS.test(name) || hasControlChar(name)) return { ok: false, error: "invalid character" };
  if (RESERVED_NAMES.test(name)) return { ok: false, error: "reserved name" };
  // Windows silently strips these, so the folder would not match what was typed.
  if (/[. ]$/.test(name)) return { ok: false, error: "cannot end with a space or period" };
  const lower = name.toLowerCase();
  if (siblings.some((s) => s.toLowerCase() === lower)) {
    return { ok: false, error: "already exists" };
  }
  return { ok: true, name };
}

/**
 * Joins a browsed directory to a child name.
 *
 * Always emits "/" — the server resolves the result, so the separator only has
 * to survive transport. Trailing separators on a root ("D:\", "/") are dropped
 * so the join never doubles.
 */
export function joinBrowsePath(base: string, name: string): string {
  return `${base.replace(/[/\\]+$/, "")}/${name}`;
}

/**
 * Last segment of a path, for the picker's "select <name>" button.
 *
 * Splits on both separators: the previous "/"-only split returned the entire
 * string unchanged for a Windows path, so the button read as the full path.
 */
export function folderLabel(path: string): string {
  const segments = path.split(/[/\\]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
