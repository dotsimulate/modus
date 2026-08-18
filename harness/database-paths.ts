import { existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join } from "path";
import { resolveAppPaths } from "./app-paths";

type DatabasePathEnvironment = Record<string, string | undefined>;

/**
 * Resolve SQLite files without allowing test workers to open the live databases.
 * Production databases live under the app data root. A legacy source database
 * must be migrated before it can be opened from the new location.
 */
export function resolveDatabasePath(
  filename: string,
  env: DatabasePathEnvironment = process.env,
  options: { homeDir?: string; sourceResourcesDir?: string; systemTempDir?: string } = {},
): string {
  const testDataDir = env.NODE_ENV === "test"
    ? join(tmpdir(), "modus-tests", String(process.pid))
    : null;
  const paths = resolveAppPaths({
    env,
    homeDir: options.homeDir,
    sourceResourcesDir: options.sourceResourcesDir ?? import.meta.dir,
    systemTempDir: options.systemTempDir,
  });
  const dataDir = testDataDir ?? paths.dataDir;
  const databasePath = join(dataDir, filename);

  if (!testDataDir && !env.MODUS_DATA_DIR?.trim() && paths.instance === null) {
    const legacyPath = join(paths.resourcesDir, filename);
    if (legacyPath !== databasePath && existsSync(legacyPath) && !existsSync(databasePath)) {
      throw new Error(
        `Legacy database migration required for ${filename}. Run \"modus start\" or `
        + `\"modus maintenance storage --dry-run\" before starting the backend directly.`,
      );
    }
  }

  mkdirSync(dataDir, { recursive: true });

  if (!isAbsolute(databasePath)) {
    throw new Error(`Database path must be absolute: ${databasePath}`);
  }
  return databasePath;
}
