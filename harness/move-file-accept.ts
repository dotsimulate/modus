/**
 * Extension matching for `file` move inputs.
 *
 * A leaf with no imports of its own, because both sides need it: the browser
 * bundle filters the picker listing with it, and the backend re-enforces the
 * same rule at activation. Keeping one implementation is what stops the picker
 * from showing a file the server will then reject.
 *
 * The containment rules live in `move-file-input.ts` — they need `path` and so
 * cannot be imported by the frontend.
 */

/** Normalize a declared extension: `png`, `.png` and `.PNG` are the same rule. */
export function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

/** True when `path` matches the accept list. An empty or absent list accepts anything. */
export function extensionAllowed(path: string, accept?: string[]): boolean {
  const allowed = (accept ?? []).map(normalizeExtension).filter(Boolean);
  if (allowed.length === 0) return true;
  const lower = path.toLowerCase();
  return allowed.some((extension) => lower.endsWith(extension));
}

/** The picker's filter, named for the side that calls it. */
export function acceptsFileName(name: string, accept?: string[]): boolean {
  return extensionAllowed(name, accept);
}
