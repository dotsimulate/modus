/**
 * Provider CLI resolution that survives a desktop launch.
 *
 * A launched app inherits the environment of whatever started it, and that is a
 * snapshot taken before the user's most recent CLI install.
 *
 * On Linux/macOS a packaged desktop app gets the session manager's environment
 * rather than the user's shell profile — PATH is typically just
 * /usr/local/bin:/usr/bin, so CLIs installed to user-owned prefixes (claude,
 * codex, agy, grok, cursor-agent) resolve in a terminal but not inside the app.
 * The directory list below is the fallback for that.
 *
 * On Windows the process PATH is Explorer's copy, and Explorer rebuilds it only
 * at sign-in. An installer that appends to the *persisted* user PATH — the Grok
 * Build CLI installs to %USERPROFILE%\.grok\bin and does exactly this — is
 * therefore invisible to an already-running app until the next reboot, even
 * though every newly opened terminal finds it. Reading the persisted value back
 * out of the registry is the fallback for that.
 *
 * PATH stays authoritative when it already finds the binary. Both fallbacks are
 * consulted only after it comes up empty, and neither ever overrides it.
 */

import { execFileSync } from "child_process";
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

/** Registry values holding the persisted PATH, user scope first. */
const WINDOWS_PATH_REGISTRY_KEYS = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
] as const;

/**
 * Pull the data out of one `reg query <key> /v Path` result.
 *
 * A row reads `    Path    REG_EXPAND_SZ    C:\a;C:\b`, and the data itself
 * contains spaces and drive colons, so the split has to stop after the type
 * token rather than tokenizing the whole line.
 */
export function parseRegistryPathValue(raw: string): string {
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (match) return match[1]!.trim();
  }
  return "";
}

/**
 * Expand the %VAR% references a REG_EXPAND_SZ PATH is allowed to contain.
 * An unresolvable reference is left verbatim so it fails as a missing directory
 * rather than silently collapsing two entries into one.
 */
export function expandWindowsEnvRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    return (key ? env[key] : undefined) ?? whole;
  });
}

/**
 * Absolute System32 path when the environment names a Windows root.
 * Resolving `reg` through PATH would defeat the purpose here — PATH is the thing
 * already known to be incomplete — and would honour any earlier `reg.exe`.
 */
export function regExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, "System32", "reg.exe") : "reg";
}

/** Both persisted PATH values joined, user scope first, "" when unreadable. */
export function readPersistedWindowsPath(
  query: (key: string) => string = defaultRegQuery,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const parts: string[] = [];
  for (const key of WINDOWS_PATH_REGISTRY_KEYS) {
    let raw: string;
    try {
      raw = query(key);
    } catch {
      continue; // A missing or unreadable hive is a fallback that does not apply.
    }
    const value = expandWindowsEnvRefs(parseRegistryPathValue(raw), env);
    if (value) parts.push(value);
  }
  return parts.join(";");
}

function defaultRegQuery(key: string): string {
  return execFileSync(regExecutable(), ["query", key, "/v", "Path"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

let persistedWindowsPath: string | undefined;

/**
 * Cached for the process lifetime. PATH carries the same "restart to pick up a
 * change" contract, so re-reading per lookup would spend a subprocess on every
 * provider spawn to answer a question that cannot have changed usefully.
 */
function windowsFallbackPath(): string {
  if (persistedWindowsPath === undefined) {
    persistedWindowsPath = process.platform === "win32" ? readPersistedWindowsPath() : "";
  }
  return persistedWindowsPath;
}

/** Test seam: drop the cached persisted PATH so the next lookup re-reads it. */
export function resetPersistedWindowsPathCache(): void {
  persistedWindowsPath = undefined;
}

/** PATH first, then the platform's fallback for prefixes PATH cannot see. */
export function resolveCli(command: string): string | null {
  const onPath = Bun.which(command);
  if (onPath) return onPath;
  if (process.platform === "win32") {
    const fallback = windowsFallbackPath();
    return fallback ? Bun.which(command, { PATH: fallback }) : null;
  }
  return resolveCliFrom(command, posixUserInstallDirs());
}

/** True when the value is launchable — a resolvable command name or an existing file path. */
export function cliExists(commandOrPath: string): boolean {
  return !!resolveCli(commandOrPath) || existsSync(commandOrPath);
}
