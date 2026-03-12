/**
 * Session ID helpers.
 *
 * Canonical persisted session IDs are UUIDs. Legacy `session-*` and `ses-*`
 * IDs are still recognized so older rows/URLs remain navigable.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_SESSION_RE = /^(session-\d+-[a-z0-9]+|ses-\d+-[a-z0-9]+)$/i;

export function isSessionId(value: string): boolean {
  return UUID_RE.test(value) || LEGACY_SESSION_RE.test(value);
}
