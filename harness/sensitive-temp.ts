import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const PREFIX = "modus-sensitive-";
const OWNER_MARKER = ".modus-owner";

/** Create a random process-private directory for short-lived credential material. */
export function createSensitiveTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  chmodSync(directory, 0o700);
  // Record the owning process so a later run can distinguish a directory
  // abandoned by a crash from one a concurrent Modus instance is still using.
  writeFileSync(join(directory, OWNER_MARKER), String(process.pid), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return directory;
}

function ownerPidOf(directory: string): number | null {
  try {
    const raw = readFileSync(join(directory, OWNER_MARKER), "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but is owned by another user.
    return error?.code === "EPERM";
  }
}

/**
 * Remove sensitive temporary directories left behind by a crashed backend.
 *
 * Only directories carrying an ownership marker for a dead process are removed.
 * A directory without a marker is left alone: it may belong to an older build or
 * to a process this one cannot inspect, and deleting a live provider's
 * credential directory mid-turn is worse than leaving it.
 */
export function pruneAbandonedSensitiveTempDirectories(): number {
  const root = resolve(tmpdir());
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const directory = join(root, entry);
    if (!existsSync(join(directory, OWNER_MARKER))) continue;
    const pid = ownerPidOf(directory);
    if (pid === null || pid === process.pid || isProcessAlive(pid)) continue;
    try {
      removeSensitiveTempDirectory(directory);
      removed += 1;
    } catch { /* best effort */ }
  }
  return removed;
}

/** Create, rather than overwrite, a private file inside a sensitive temp directory. */
export function writeSensitiveTempFile(directory: string, name: string, content: string): string {
  if (basename(name) !== name) throw new Error("sensitive temporary file name must be a basename");
  const path = join(directory, name);
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  return path;
}

/** Remove only a directory created by createSensitiveTempDirectory. */
export function removeSensitiveTempDirectory(directory: string): void {
  const resolvedDirectory = resolve(directory);
  const resolvedTemp = resolve(tmpdir());
  if (dirname(resolvedDirectory) !== resolvedTemp || !basename(resolvedDirectory).startsWith(PREFIX)) {
    throw new Error(`refusing to remove unrecognized sensitive temporary directory: ${directory}`);
  }
  // Keep the separator assertion explicit so a future tmpdir/path change cannot
  // turn this into a prefix-only recursive deletion check.
  if (!resolvedDirectory.startsWith(`${resolvedTemp}${sep}`)) {
    throw new Error(`refusing to remove sensitive temporary directory outside the system temp root: ${directory}`);
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
}
