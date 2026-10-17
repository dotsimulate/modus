/**
 * The tag gate on a `session` trigger.
 *
 * `excludeTags` skips a session carrying any of its tags, and defaults to
 * `["internal"]` so an action never fires on the sessions actions spawn.
 * `includeTags` is the opt-in half: when present, the session must carry at
 * least one of them. That is what turns a session trigger into a per-session
 * switch without the action running on every conversation in the Vault.
 * Exclusion wins when a session carries both.
 *
 * Its own module rather than a function in action-runner.ts so a test can reach
 * it without importing the runner, which opens the database at module load.
 */

import type { SessionTrigger } from "./action-types";

export function sessionTagsMatchTrigger(
  trigger: Pick<SessionTrigger, "excludeTags" | "includeTags">,
  tags: readonly string[],
): boolean {
  const excludeTags = trigger.excludeTags ?? ["internal"];
  if (excludeTags.some((tag) => tags.includes(tag))) return false;
  // An empty list is treated as absent: `[]` reads as "no filter", and a gate
  // nothing can ever pass would make the action silently dead.
  const includeTags = trigger.includeTags ?? [];
  if (includeTags.length > 0 && !includeTags.some((tag) => tags.includes(tag))) return false;
  return true;
}
