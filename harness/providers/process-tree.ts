import { spawn, type ChildProcess } from "child_process";

/**
 * Shared child-process lifecycle helpers for subprocess providers.
 *
 * `ChildProcess.killed` only records that a signal was delivered, so it is never
 * proof that the process — let alone its descendants — has exited. Providers must
 * use `hasExited` for liveness and `terminateProcessTree` for teardown, then wait
 * for close before treating a generation as finished.
 */

/** True only once the child has actually exited or been terminated by a signal. */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null;
}

/** Resolve true when the child closes, false if the timeout elapses first. */
export function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("close", onClose);
    if (hasExited(child)) finish(true);
  });
}

/**
 * Terminate the child and every descendant it owns.
 *
 * On Windows this uses `taskkill /T`, which is the only reliable way to reach a
 * shim's grandchildren. On POSIX it signals the process group when the child was
 * spawned `detached`, and otherwise falls back to the direct child — a fallback,
 * not descendant ownership.
 */
export async function terminateProcessTree(child: ChildProcess, force: boolean): Promise<void> {
  if (hasExited(child)) return;
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
    return;
  }
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* not a group leader — fall back to the direct child */ }
  }
  try { child.kill(signal); } catch { /* best effort */ }
}
