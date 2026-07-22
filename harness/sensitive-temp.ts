import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const PREFIX = "modus-sensitive-";

/** Create a random process-private directory for short-lived credential material. */
export function createSensitiveTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), PREFIX));
  chmodSync(directory, 0o700);
  return directory;
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
