/**
 * Project runtime root — where move runtime state lives.
 *
 * Move API registrations and persisted instance state used to be written into
 * `<cwd>/.modus/moves/<name>/state/`, i.e. inside the authored move directory a
 * user publishes. Containment was one hand-maintained `.gitignore` line per
 * example move, and a missed line publishes live `mapi-` tokens, session IDs and
 * absolute machine paths.
 *
 * Everything runtime now lands under `<cwd>/.modus/runtime/` instead. The
 * existing `.modus/*` ignore rule already covers it, so containment needs no
 * per-move maintenance and cannot rot the same way.
 *
 * Two rules the callers depend on:
 *
 *   1. Reads fall back to the legacy in-move location, writes never do. An
 *      install upgraded mid-flight keeps answering its already-issued tokens.
 *   2. A read NEVER migrates by writing. One rehydration scope is the packaged
 *      resources directory, which may be read-only and is not ours to rewrite.
 *      Legacy files are left where they are and simply stop being written to.
 *
 * The index exists so boot does not have to enumerate and stat every historical
 * move directory to discover which ones hold registrations.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Runtime root, relative to a project. Ignored by the existing `.modus/*` rule. */
export const MOVE_RUNTIME_DIR = ".modus/runtime";

/** Legacy location, still read so tokens issued before this change keep working. */
const LEGACY_MOVES_DIR = ".modus/moves";

const INDEX_VERSION = 1;

type MoveRuntimeIndex = { version: number; moves: string[] };

/** `<cwd>/.modus/runtime/moves` — the parent of every per-move runtime directory. */
export function moveRuntimeMovesRoot(cwd: string): string {
  return join(cwd, MOVE_RUNTIME_DIR, "moves");
}

/** Where a move's API registrations are written. */
export function moveRegistryPath(cwd: string, moveName: string): string {
  return join(moveRuntimeMovesRoot(cwd), moveName, "registry.json");
}

/** Where a move's API registrations were written before the runtime root existed. */
export function legacyMoveRegistryPath(cwd: string, moveName: string): string {
  return join(cwd, LEGACY_MOVES_DIR, moveName, "state", "_registry.json");
}

/** Where an instance's persisted state is written. */
export function moveStatePath(cwd: string, moveName: string, instanceId: string): string {
  return join(moveRuntimeMovesRoot(cwd), moveName, "state", `${instanceId}.json`);
}

/** Where an instance's persisted state was written before the runtime root existed. */
export function legacyMoveStatePath(cwd: string, moveName: string, instanceId: string): string {
  return join(cwd, LEGACY_MOVES_DIR, moveName, "state", `${instanceId}.json`);
}

/**
 * The path to read from: the runtime root when it holds a file, else the legacy
 * one. Returns the runtime path when neither exists, so a caller that reports a
 * missing file names the location we actually write.
 */
export function readablePath(runtimePath: string, legacyPath: string): string {
  if (existsSync(runtimePath)) return runtimePath;
  if (existsSync(legacyPath)) return legacyPath;
  return runtimePath;
}

function indexPath(cwd: string): string {
  return join(moveRuntimeMovesRoot(cwd), "index.json");
}

/** Move names known to hold runtime registrations. Empty when nothing was written yet. */
export function readMoveRuntimeIndex(cwd: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(cwd), "utf-8")) as MoveRuntimeIndex;
    if (!Array.isArray(parsed?.moves)) return [];
    return parsed.moves.filter((name): name is string => typeof name === "string" && name.length > 0);
  } catch {
    return [];
  }
}

/** Rewrite the index. Sorted so the file does not churn on unrelated writes. */
function writeMoveRuntimeIndex(cwd: string, moves: string[]): void {
  const path = indexPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const payload: MoveRuntimeIndex = { version: INDEX_VERSION, moves: [...new Set(moves)].sort() };
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

/**
 * Keep the index in step with a registry write. `present` is false when the
 * write emptied the registry, so a move that no longer holds registrations stops
 * being visited at boot.
 */
export function updateMoveRuntimeIndex(cwd: string, moveName: string, present: boolean): void {
  const current = readMoveRuntimeIndex(cwd);
  const has = current.includes(moveName);
  if (present === has) return;
  const next = present ? [...current, moveName] : current.filter((name) => name !== moveName);
  writeMoveRuntimeIndex(cwd, next);
}

/**
 * Every move name boot has to consider for this project.
 *
 * The index answers it outright once a project has written anything under the
 * runtime root. Legacy directories are still enumerated, because a project
 * upgraded mid-flight has registrations that predate the index — but that
 * enumeration disappears on its own as soon as the legacy directory is gone,
 * which is the point of the index.
 */
export function listRuntimeMoveNames(cwd: string): string[] {
  const names = new Set(readMoveRuntimeIndex(cwd));
  const legacyRoot = join(cwd, LEGACY_MOVES_DIR);
  if (existsSync(legacyRoot)) {
    try {
      for (const entry of readdirSync(legacyRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) names.add(entry.name);
      }
    } catch {
      // Unreadable project directory — the index is still authoritative.
    }
  }
  return [...names];
}
