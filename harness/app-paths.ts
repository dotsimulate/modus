import { mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

export type AppPathEnvironment = Record<string, string | undefined>;

export type AppPaths = {
  resourcesDir: string;
  modusHome: string;
  dataDir: string;
  logsDir: string;
  runtimeDir: string;
  cacheDir: string;
  tempDir: string;
  instance: string | null;
};

type ResolveAppPathsOptions = {
  env?: AppPathEnvironment;
  homeDir?: string;
  sourceResourcesDir?: string;
  systemTempDir?: string;
};

/**
 * Strip the Windows `\\?\` extended-length path prefix (and its UNC form).
 * The desktop shell may hand us `MODUS_RESOURCES_DIR=\\?\C:\...`, but Bun's
 * dynamic `import()` cannot resolve a module from a `\\?\`-prefixed path, so
 * every built-in move loaded out of the resources dir fails to load. Resource
 * paths are well under the 260-char limit, so the prefix is safe to drop.
 */
function stripExtendedLengthPrefix(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice("\\\\?\\UNC\\".length);
  if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
  return p;
}

function configuredPath(value: string | undefined, fallback: string): string {
  return stripExtendedLengthPrefix(resolve(value?.trim() || fallback));
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const sourceResourcesDir = options.sourceResourcesDir ?? import.meta.dir;
  const instanceValue = env.MODUS_INSTANCE?.trim() || "";
  if (instanceValue && !/^[A-Za-z0-9._-]+$/.test(instanceValue)) {
    throw new Error("MODUS_INSTANCE may contain only letters, numbers, dots, underscores, and hyphens");
  }
  const instance = instanceValue && instanceValue !== "default" ? instanceValue : null;
  const modusHome = configuredPath(env.MODUS_HOME, join(homeDir, ".modus"));
  const writableRoot = instance ? join(modusHome, instance) : modusHome;

  return {
    resourcesDir: configuredPath(env.MODUS_RESOURCES_DIR, sourceResourcesDir),
    modusHome,
    dataDir: configuredPath(env.MODUS_DATA_DIR, join(writableRoot, "data")),
    logsDir: configuredPath(env.MODUS_LOGS_DIR, join(writableRoot, "logs")),
    runtimeDir: configuredPath(env.MODUS_RUNTIME_DIR, join(writableRoot, "runtime")),
    cacheDir: configuredPath(env.MODUS_CACHE_DIR, join(writableRoot, "cache")),
    tempDir: join(options.systemTempDir ?? tmpdir(), "modus", instance ?? "default"),
    instance,
  };
}

export const APP_PATHS = resolveAppPaths();

export function ensureWritableAppPaths(paths: AppPaths = APP_PATHS): void {
  for (const dir of [paths.modusHome, paths.dataDir, paths.logsDir, paths.runtimeDir, paths.cacheDir, paths.tempDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
