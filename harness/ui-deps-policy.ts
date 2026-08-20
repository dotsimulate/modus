/**
 * Decides whether the UI's installed dependencies need reinstalling before a
 * build. Pure so it can be tested without driving the CLI; `cli.ts` supplies
 * the filesystem readings.
 */

export type UiDepsState = {
  /** `harness/ui/node_modules` exists. */
  nodeModulesPresent: boolean;
  /** mtime of the install stamp, or 0 when it does not exist. */
  stampTime: number;
  /** mtime of `package.json`, or 0 when it does not exist. */
  packageTime: number;
  /** mtime of the lockfile, or 0 when it does not exist. */
  lockTime: number;
};

/**
 * The stamp is gitignored, so it never arrives with a clone or a pull. A
 * missing stamp therefore means "no record of an install in this checkout",
 * which an existing `node_modules` does not refute — it may predate a
 * dependency that was added since. Treating that as fresh skipped the install
 * a new dependency required, and stamping at the same time made the skip
 * permanent, because the new stamp outranked the just-pulled `package.json`
 * and lockfile on every later run.
 */
export function uiDepsAreStale(state: UiDepsState): boolean {
  if (!state.nodeModulesPresent) return true;
  if (state.stampTime === 0) return true;
  return Math.max(state.packageTime, state.lockTime) > state.stampTime;
}
