/**
 * Removing a tree a just-exited child process was using.
 *
 * `await subprocess.exited` resolves when the process is reaped, but Windows
 * releases the handles it held asynchronously. A directory the backend had open
 * can stay locked for a few more milliseconds — long enough for an immediate
 * recursive delete to throw `EBUSY` and fail a run in which every test passed.
 * The symptom is `(fail) (unnamed)` from the `afterAll` hook, which names
 * neither the test nor the file.
 *
 * POSIX unlinks open files without complaint, so this only ever retries on
 * Windows, and only on the codes that mean "still letting go" rather than
 * "wrong". Same set `isWindowsLockTransitionError` uses in `vault-registry.ts`.
 */
import { rmSync } from "fs";

/** Codes Windows raises while a handle is still closing, not because the call was wrong. */
const LOCK_TRANSITION_CODES = ["EBUSY", "EACCES", "EPERM", "ENOTEMPTY"];

const RETRY_DELAY_MS = 50;
const MAX_ATTEMPTS = 40;

function isLockTransitionError(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return process.platform === "win32" && LOCK_TRANSITION_CODES.includes(code ?? "");
}

/**
 * Recursively remove `target`, waiting out a Windows handle release.
 *
 * Bounded at two seconds so it stays well inside the surrounding hook budget:
 * a tree that is still locked after that is a real leak and should be reported,
 * not swallowed.
 */
export async function removeTreeAfterExit(target: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isLockTransitionError(error) || attempt >= MAX_ATTEMPTS) throw error;
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
}
