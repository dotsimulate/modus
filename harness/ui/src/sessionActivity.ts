/**
 * When a session's conversation last moved.
 *
 * Leaf module with no imports of its own so it can be unit-tested without React,
 * and so every surface that orders or buckets sessions answers the question the
 * same way.
 *
 * The rule: order sessions by conversation time, never by row-write time.
 * `updated_at` is written whenever the row changes — renaming a chat, pinning or
 * unpinning it (a tag write), a status reconcile — none of which mean the
 * conversation said anything. Bucketing on it moved a week-old session into
 * "today" the moment its title was edited. `last_message_at` is the same key the
 * backend already orders its own session list by (`ORDER BY last_message_at DESC`),
 * so this keeps the client consistent with the server rather than inventing a
 * second ordering.
 */

/** The subset of a session row this rule needs. */
export type SessionActivityFields = {
  last_message_at?: number | null;
  created_at?: number | null;
  updated_at?: number | null;
};

/**
 * Falls back through creation time before row-write time: a session that has
 * never carried a message should sort by when it was started, not by the last
 * time something touched its row.
 */
export function sessionActivityAt(s: SessionActivityFields): number {
  return s.last_message_at || s.created_at || s.updated_at || 0;
}
