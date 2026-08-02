/**
 * Provider CLI resolution that survives a desktop launch.
 *
 * A packaged desktop app on Linux/macOS inherits the session manager's
 * environment, not the user's shell profile — PATH is typically just
 * /usr/local/bin:/usr/bin, so CLIs installed to user-owned prefixes
 * (claude, codex, agy, grok, cursor-agent) resolve in a terminal but not
 * inside the app. PATH stays authoritative when it already finds the
 * binary; the directories here are fallbacks, never overrides.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Per-user install prefixes worth probing when PATH comes up empty. */
export function posixUserInstallDirs(home = homedir()): string[] {
  if (process.platform === "win32") return [];
  return [
    join(home, ".local", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
  ];
}

/** Pure lookup over an explicit directory list. */
export function resolveCliFrom(
  command: string,
  dirs: string[],
  exists: (path: string) => boolean = existsSync,
): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** PATH first, then well-known per-user install directories. */
export function resolveCli(command: string): string | null {
  return Bun.which(command) ?? resolveCliFrom(command, posixUserInstallDirs());
}

/** True when the value is launchable — a PATH-resolvable name or an existing file path. */
export function cliExists(commandOrPath: string): boolean {
  return !!Bun.which(commandOrPath) || existsSync(commandOrPath);
}
