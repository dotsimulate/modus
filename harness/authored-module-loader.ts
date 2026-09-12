/**
 * Authored module loader — imports trusted action and move context.ts modules.
 *
 * Bun never releases an evaluated module. Importing a context file under a fresh
 * URL, or evicting it from require.cache and importing it again, evaluates a new
 * copy of its module graph and keeps every previous copy alive for the life of
 * the process. Done on every action tick or every chat turn, that is an unbounded
 * native-memory leak.
 *
 * A module is therefore re-evaluated only when its source changed. The loader
 * fingerprints the entry file, any declared watch paths, and every unit-local
 * file the previous import actually loaded (mtime + size), and returns the cached
 * exports while that fingerprint holds. Editing a context.ts or one of its sibling
 * imports still hot-reloads on the next call. Each edit retains one old copy,
 * which is the floor under Bun; repeated calls retain nothing.
 *
 * Imports under node_modules or outside the unit directory are shared and never
 * evicted: evicting a core module such as db.ts would re-run its top-level side
 * effects (a second database handle, a second checkpoint timer).
 */

import { readdirSync, statSync } from "fs";
import { isAbsolute, join, relative } from "path";

export type AuthoredModuleOptions = {
  /** Directory whose local files form the hot-reload unit. */
  unitDir: string;
  /** Extra paths whose change forces a reload, e.g. a move's package.json. */
  watchPaths?: string[];
  /** Runs before every (re)import, e.g. installing move-local dependencies. */
  beforeImport?: () => Promise<void>;
};

type LoadedModule =
  | { version: string; tracked: string[]; ok: true; mod: unknown }
  | { version: string; tracked: string[]; ok: false; error: unknown; recoveryPaths: string[] };

const loadedModules = new Map<string, LoadedModule>();
const inFlightLoads = new Map<string, Promise<unknown>>();

function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function versionOf(tracked: string[], stamps?: Map<string, string>): string {
  return tracked.map((path) => `${path}=${stamps?.get(path) ?? fileStamp(path)}`).join("|");
}

function isUnitLocal(unitDir: string, path: string): boolean {
  const local = relative(unitDir, path);
  if (!local || local.startsWith("..") || isAbsolute(local)) return false;
  return !local.split(/[\\/]/).includes("node_modules");
}

function unitLocalCacheKeys(unitDir: string): string[] {
  return Object.keys(require.cache).filter((path) => isUnitLocal(unitDir, path));
}

// A dependency that failed to parse/resolve may never enter require.cache.
// On failure, also watch source files and directories (including additions),
// so fixing that dependency recovers without editing an unrelated context.ts.
function failedImportPaths(unitDir: string): string[] {
  const paths = [unitDir];
  try {
    for (const entry of readdirSync(unitDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(unitDir, entry.name);
      if (entry.isDirectory()) paths.push(...failedImportPaths(path));
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|json)$/.test(entry.name)) paths.push(path);
    }
  } catch { /* A removed directory is still watched for recreation. */ }
  return paths;
}

/**
 * Import an authored module, re-evaluating it only when its tracked source changed.
 * A failed import is remembered too: it is rethrown without re-importing until a
 * tracked file changes, so a broken module on a 30-second trigger does not leak a
 * copy per attempt.
 */
export async function importAuthoredModule<T>(entryPath: string, opts: AuthoredModuleOptions): Promise<T> {
  const inFlight = inFlightLoads.get(entryPath);
  if (inFlight) return inFlight as Promise<T>;

  const current = loadedModules.get(entryPath);
  if (current && versionOf(current.tracked) === current.version) {
    if (!current.ok) throw current.error;
    return current.mod as T;
  }

  const load = (async (): Promise<T> => {
    await opts.beforeImport?.();

    // Stamp before importing, so an edit that lands mid-import is still seen as
    // a change on the next call rather than folded into this version.
    const previousTracked = current && !current.ok
      ? current.tracked.filter((path) => !current.recoveryPaths.includes(path))
      : current?.tracked ?? [];
    const known = [...new Set([entryPath, ...(opts.watchPaths ?? []), ...previousTracked])];
    const stamps = new Map(known.map((path) => [path, fileStamp(path)]));

    // Evicting an ESM module while Bun is still instantiating it fails with
    // "Requested module is not instantiated yet"; the in-flight map above
    // guarantees a single import per entry at a time.
    for (const cachePath of unitLocalCacheKeys(opts.unitDir)) delete require.cache[cachePath];
    if (current && !current.ok) {
      for (const path of current.recoveryPaths) {
        if (isUnitLocal(opts.unitDir, path)) delete require.cache[path];
      }
    }
    // Bun can retain a failed entry without exposing it in Object.keys(cache).
    delete require.cache[entryPath];

    const trackedAfter = () => [...new Set([...known, ...unitLocalCacheKeys(opts.unitDir)])].sort();
    try {
      const mod = await import(entryPath);
      const tracked = trackedAfter();
      loadedModules.set(entryPath, { version: versionOf(tracked, stamps), tracked, ok: true, mod });
      return mod as T;
    } catch (error) {
      const importedPaths = trackedAfter();
      const recoveryPaths = failedImportPaths(opts.unitDir).filter((path) => !importedPaths.includes(path));
      const tracked = [...importedPaths, ...recoveryPaths].sort();
      loadedModules.set(entryPath, { version: versionOf(tracked, stamps), tracked, ok: false, error, recoveryPaths });
      throw error;
    }
  })();

  inFlightLoads.set(entryPath, load);
  try {
    return await load;
  } finally {
    if (inFlightLoads.get(entryPath) === load) inFlightLoads.delete(entryPath);
  }
}
