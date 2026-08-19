import { mkdirSync } from "fs";
import { homedir, tmpdir } from "os";
import { isAbsolute, join, posix, resolve, win32 } from "path";

export type AppPathEnvironment = Record<string, string | undefined>;

export type AppPaths = {
  resourcesDir: string;
  modusHome: string;
  writableRoot: string;
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

export type PathFlavor = "win32" | "posix";

/** True when `candidate` is the root itself or a descendant, using explicit platform semantics. */
export function isPathWithinRoot(
  root: string,
  candidate: string,
  flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix",
): boolean {
  const api = flavor === "win32" ? win32 : posix;
  const normalizedRoot = api.resolve(root);
  const normalizedCandidate = api.resolve(candidate);
  const offset = api.relative(normalizedRoot, normalizedCandidate);
  return offset === "" || (!offset.startsWith(`..${api.sep}`) && offset !== ".." && !api.isAbsolute(offset));
}

function isSamePath(
  left: string,
  right: string,
  flavor: PathFlavor = process.platform === "win32" ? "win32" : "posix",
): boolean {
  const api = flavor === "win32" ? win32 : posix;
  const normalizedLeft = api.resolve(left);
  const normalizedRight = api.resolve(right);
  return flavor === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function configuredNamedPath(
  envName: string,
  value: string | undefined,
  fallback: string,
  vaultRoot: string,
): string {
  const configured = configuredPath(value, fallback);
  if (isSamePath(vaultRoot, configured) || !isPathWithinRoot(vaultRoot, configured)) {
    throw new Error(`${envName} must resolve inside MODUS_VAULT_ROOT for a named Vault`);
  }
  return configured;
}

export function isValidInstanceName(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);
}

/** Canonical Vault identity. Display casing belongs in the registry `name`. */
export function normalizeInstanceName(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && isValidInstanceName(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const sourceResourcesDir = options.sourceResourcesDir ?? import.meta.dir;
  const instanceValue = env.MODUS_INSTANCE?.trim() || "";
  const normalizedInstance = instanceValue ? normalizeInstanceName(instanceValue) : null;
  if (instanceValue && !normalizedInstance) {
    throw new Error("MODUS_INSTANCE must be a single name containing only letters, numbers, dots, underscores, and hyphens");
  }
  const instance = normalizedInstance && normalizedInstance !== "default" ? normalizedInstance : null;
  const namedRootValue = env.MODUS_VAULT_ROOT?.trim() || "";
  if (instance && !namedRootValue) {
    throw new Error("MODUS_VAULT_ROOT is required when MODUS_INSTANCE selects a named Vault");
  }
  if (instance && !isAbsolute(stripExtendedLengthPrefix(namedRootValue))) {
    throw new Error("MODUS_VAULT_ROOT must be an absolute path for a named Vault");
  }
  const defaultModusHome = configuredPath(env.MODUS_HOME, join(homeDir, ".modus"));
  const writableRoot = instance
    ? configuredPath(namedRootValue, namedRootValue)
    : defaultModusHome;
  const modusHome = writableRoot;
  const dataDir = instance
    ? configuredNamedPath("MODUS_DATA_DIR", env.MODUS_DATA_DIR, join(writableRoot, "data"), writableRoot)
    : configuredPath(env.MODUS_DATA_DIR, join(writableRoot, "data"));
  const logsDir = instance
    ? configuredNamedPath("MODUS_LOGS_DIR", env.MODUS_LOGS_DIR, join(writableRoot, "logs"), writableRoot)
    : configuredPath(env.MODUS_LOGS_DIR, join(writableRoot, "logs"));
  const runtimeDir = instance
    ? configuredNamedPath("MODUS_RUNTIME_DIR", env.MODUS_RUNTIME_DIR, join(writableRoot, "runtime"), writableRoot)
    : configuredPath(env.MODUS_RUNTIME_DIR, join(writableRoot, "runtime"));
  const cacheDir = instance
    ? configuredNamedPath("MODUS_CACHE_DIR", env.MODUS_CACHE_DIR, join(writableRoot, "cache"), writableRoot)
    : configuredPath(env.MODUS_CACHE_DIR, join(writableRoot, "cache"));

  return {
    resourcesDir: configuredPath(env.MODUS_RESOURCES_DIR, sourceResourcesDir),
    modusHome,
    writableRoot,
    dataDir,
    logsDir,
    runtimeDir,
    cacheDir,
    tempDir: instance
      ? join(writableRoot, "tmp")
      : join(options.systemTempDir ?? tmpdir(), "modus", "default"),
    instance,
  };
}

export const APP_PATHS = resolveAppPaths();

export function ensureWritableAppPaths(paths: AppPaths = APP_PATHS): void {
  for (const dir of [paths.modusHome, paths.writableRoot, paths.dataDir, paths.logsDir, paths.runtimeDir, paths.cacheDir, paths.tempDir]) {
    mkdirSync(dir, { recursive: true });
  }
}
