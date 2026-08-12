/**
 * Pure logic behind the composer's docked move form.
 *
 * Kept outside `ComposerMoveForm.tsx` so it is testable without React and the
 * API client — the same reason `move-host-imports.ts` sits outside the loader.
 */

import type { MoveInput, MoveListItem, ProfileMoveBinding } from "../../sdk/index";

/** Mirror of `stringifyDefault` in MoveInputFields, which cannot be imported here (React). */
function defaultToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "yes" : "";
  return String(value);
}

/**
 * Seed form state from a binding's declared inputs, falling back to each input's
 * own default. A profile binding may supply some fields and ask for the rest, so
 * a supplied value always wins and an absent one falls through to the default.
 *
 * Toggles are stored as the form's "yes"/"" convention rather than a boolean,
 * because that is what `MoveInputFields` reads and `buildMoveInputs` converts
 * back. A binding written as `{"verbose": true}` and one written as
 * `{"verbose": "yes"}` therefore mean the same thing.
 */
export function seedFormValues(
  inputs: MoveInput[] | undefined,
  initial: Record<string, unknown> | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs ?? []) {
    const supplied = initial?.[input.name];
    if (supplied !== undefined) {
      values[input.name] = input.type === "toggle"
        ? (supplied === true || supplied === "yes" ? "yes" : "")
        : String(supplied);
      continue;
    }
    if (input.default !== undefined) values[input.name] = defaultToString(input.default);
  }
  return values;
}

export type PendingAsk = {
  move: MoveListItem;
  initialValues?: Record<string, unknown>;
};

/**
 * Profile move bindings that will inject into the *next* message and have not
 * yet done so — what the composer shows as pending attachments before the user
 * sends their first message.
 *
 * `startSessionWithMoves` gathers a profile's non-persistent bindings pre-spawn
 * and prepends the result to that first message, so this is the only moment the
 * user can see, or refuse, that injection. Excluded here:
 *
 *   - `ask` bindings — those raise a form instead (`pendingProfileAsks`)
 *   - persistent bindings — they activate post-spawn as ambient moves and
 *     already have their own chips with a working deactivate
 *   - bindings naming a move this project does not have — the harness warns and
 *     skips, so promising an attachment would be a lie
 *
 * A move with no `inputs` is deliberately kept: it injects context without
 * asking anything, which is exactly the case the user could not see before.
 */
export function pendingProfileInjections(
  bindings: ProfileMoveBinding[] | undefined,
  available: MoveListItem[],
): MoveListItem[] {
  const byName = new Map(available.map((move) => [move.name, move]));
  const pending: MoveListItem[] = [];
  for (const binding of bindings ?? []) {
    if (binding.ask) continue;
    const move = byName.get(binding.name);
    if (!move || move.persistent) continue;
    pending.push(move);
  }
  return pending;
}

/**
 * Which of a profile's move bindings should raise a form in the composer.
 *
 * Three things are dropped, and each drop matches what the harness already did
 * at session start, so the UI never offers a form for a move that will not run:
 *   - bindings without `ask` (the harness activated them normally)
 *   - bindings naming a move this project does not have
 *   - moves declaring no inputs — `ask` has nothing to ask for, and the harness
 *     skipped it, so an empty form would be a dead end
 *
 * Order follows the profile's declaration order, which is the only order the
 * author controls.
 */
export function pendingProfileAsks(
  bindings: ProfileMoveBinding[] | undefined,
  available: MoveListItem[],
): PendingAsk[] {
  const byName = new Map(available.map((move) => [move.name, move]));
  const asks: PendingAsk[] = [];
  for (const binding of bindings ?? []) {
    if (!binding.ask) continue;
    const move = byName.get(binding.name);
    if (!move || !(move.inputs?.length ?? 0)) continue;
    asks.push({ move, initialValues: binding.inputs });
  }
  return asks;
}
