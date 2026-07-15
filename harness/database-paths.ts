import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";

type DatabasePathEnvironment = Record<string, string | undefined>;

/**
 * Resolve SQLite files without allowing test workers to open the live databases.
 * Production keeps the legacy harness-local location until the desktop path
 * migration is completed in its own post-checkpoint commit.
 */
export function resolveDatabasePath(
  filename: string,
  env: DatabasePathEnvironment = process.env,
): string {
  const configuredDataDir = env.MODUS_DATA_DIR?.trim();
  const dataDir = configuredDataDir
    ? resolve(configuredDataDir)
    : env.NODE_ENV === "test"
      ? join(tmpdir(), "modus-tests", String(process.pid))
      : import.meta.dir;

  if (dataDir !== import.meta.dir) {
    mkdirSync(dataDir, { recursive: true });
  }

  const databasePath = join(dataDir, filename);
  if (!isAbsolute(databasePath)) {
    throw new Error(`Database path must be absolute: ${databasePath}`);
  }
  return databasePath;
}
