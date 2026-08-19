/** Main-owned registry of named Vault folder pointers. Registry removal never removes Vault data. */

import { randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import {
  APP_PATHS,
  isPathWithinRoot,
  normalizeInstanceName,
  type AppPaths,
} from "./app-paths";
import { homeVaultsJsonPath } from "./modus-home";
import type { NamedVault } from "./vault-types";
import { DENY_ALL_POLICY, writeVaultPolicy } from "./vault-policy";

export type VaultRegistryEntry = NamedVault;
export type VaultRegistryPaths = Pick<AppPaths, "modusHome">;
export type VaultRootMode = "initialize" | "register";

export type VaultRootRegistration = {
  slug: string;
  root: string;
  name?: string;
  mode: VaultRootMode;
};

export type VaultManifest = {
  version: 1;
  slug: string;
  createdAt: number;
};

type VaultsFile = {
  vaults: Array<Omit<VaultRegistryEntry, "requiresRepair">>;
};

export type VaultRegistryUpdate = {
  name?: string;
  autostart?: boolean;
  lastOpenedAt?: number;
};

export const VAULT_MANIFEST_FILENAME = "vault-manifest.json";
export const VAULT_MANIFEST_VERSION = 1 as const;

export class VaultAlreadyExistsError extends Error {
  constructor(readonly slug: string) {
    super(`Vault "${slug}" already exists`);
    this.name = "VaultAlreadyExistsError";
  }
}

export class VaultFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultFolderError";
  }
}

const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;
const REGISTRY_LOCK_STALE_MS = 30_000;

type RegistryLock = {
  assertOwned: () => void;
  release: () => void;
};

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stripExtendedLengthPrefix(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return "\\\\" + path.slice("\\\\?\\UNC\\".length);
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

/** Canonical absolute root used for registry storage and duplicate comparison. */
export function canonicalVaultRoot(value: string): string {
  const trimmed = stripExtendedLengthPrefix(value.trim());
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new VaultFolderError("Vault root must be an absolute path");
  }
  const absolute = resolve(trimmed);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return absolute;
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    return join(stripExtendedLengthPrefix(realpathSync.native(existing)), ...missing);
  } catch (error) {
    throw new VaultFolderError(`Could not resolve Vault root ${absolute}: ${String(error)}`);
  }
}

function rootComparisonKey(root: string): string {
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function assertRootOutsideMain(root: string, paths: VaultRegistryPaths): void {
  const mainHome = canonicalVaultRoot(paths.modusHome);
  if (isPathWithinRoot(mainHome, root)) {
    throw new VaultFolderError("Named Vault roots must be outside Main's Modus home");
  }
}

function parseEntry(value: unknown): VaultRegistryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.slug !== "string") return null;
  const slug = normalizeInstanceName(entry.slug);
  if (!slug || slug === "default") return null;
  if (!isTimestamp(entry.createdAt)) return null;
  if (entry.name !== undefined && typeof entry.name !== "string") return null;
  if (entry.autostart !== undefined && typeof entry.autostart !== "boolean") return null;
  if (entry.lastOpenedAt !== undefined && !isTimestamp(entry.lastOpenedAt)) return null;

  const base = {
    slug,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    createdAt: entry.createdAt,
    ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
  };
  if (entry.root === undefined) {
    return { ...base, requiresRepair: true, autostart: false };
  }
  if (typeof entry.root !== "string") return null;
  let root: string;
  try {
    root = canonicalVaultRoot(entry.root);
  } catch {
    return null;
  }
  return {
    ...base,
    root,
    ...(entry.autostart !== undefined ? { autostart: entry.autostart } : {}),
  };
}

function persistedEntry(entry: VaultRegistryEntry): Omit<VaultRegistryEntry, "requiresRepair"> {
  const { requiresRepair: _, ...persisted } = entry;
  if (!persisted.root) delete persisted.root;
  return persisted;
}

function registryPath(paths: VaultRegistryPaths): string {
  return homeVaultsJsonPath(paths.modusHome);
}

function registryLockPath(paths: VaultRegistryPaths): string {
  return `${registryPath(paths)}.lock`;
}

function fsErrorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

function isWindowsLockTransitionError(error: unknown): boolean {
  return process.platform === "win32" && ["EACCES", "EBUSY", "EPERM"].includes(fsErrorCode(error) ?? "");
}

function lockOwnerPid(path: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").split(":", 1)[0] ?? "", 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fsErrorCode(error) === "EPERM";
  }
}

function warnCorrupt(path: string): void {
  console.warn(`[vaults] Failed to read ${path}; treating registry as empty`);
}

function readRegistry(paths: VaultRegistryPaths): VaultRegistryEntry[] {
  const path = registryPath(paths);
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      warnCorrupt(path);
      return [];
    }
    const rawEntries = (value as { vaults?: unknown }).vaults;
    if (rawEntries === undefined) return [];
    if (!Array.isArray(rawEntries)) {
      warnCorrupt(path);
      return [];
    }
    const entries = rawEntries.map(parseEntry);
    if (entries.some((entry) => !entry)) {
      warnCorrupt(path);
      return [];
    }
    const parsed = entries as VaultRegistryEntry[];
    if (new Set(parsed.map((entry) => entry.slug)).size !== parsed.length) {
      warnCorrupt(path);
      return [];
    }
    const rooted = parsed.filter((entry): entry is VaultRegistryEntry & { root: string } => !!entry.root);
    if (new Set(rooted.map((entry) => rootComparisonKey(entry.root))).size !== rooted.length) {
      warnCorrupt(path);
      return [];
    }
    for (const entry of rooted) assertRootOutsideMain(entry.root, paths);
    return parsed;
  } catch {
    warnCorrupt(path);
    return [];
  }
}

function writeRegistry(entries: VaultRegistryEntry[], paths: VaultRegistryPaths): void {
  const path = registryPath(paths);
  mkdirSync(dirname(path), { recursive: true });
  const value: VaultsFile = { vaults: entries.map(persistedEntry) };
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function acquireRegistryLock(paths: VaultRegistryPaths): RegistryLock {
  const path = registryLockPath(paths);
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;

  while (true) {
    try {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, `${token}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
      const assertOwned = () => {
        if (readFileSync(path, "utf8").trim() !== token) {
          throw new Error(`Vault registry lock ownership was lost: ${path}`);
        }
      };
      return {
        assertOwned,
        release: () => {
          try {
            if (readFileSync(path, "utf8").trim() === token) unlinkSync(path);
          } catch (error) {
            if (fsErrorCode(error) !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if (fsErrorCode(error) !== "EEXIST" && !isWindowsLockTransitionError(error)) throw error;
    }

    try {
      const stale = Date.now() - statSync(path).mtimeMs >= REGISTRY_LOCK_STALE_MS;
      const ownerPid = lockOwnerPid(path);
      if ((ownerPid !== null && !processIsAlive(ownerPid)) || (ownerPid === null && stale)) {
        unlinkSync(path);
        continue;
      }
    } catch (error) {
      if (fsErrorCode(error) === "ENOENT") continue;
      if (isWindowsLockTransitionError(error)) {
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for Vault registry lock: ${path}`);
        }
        Bun.sleepSync(REGISTRY_LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Vault registry lock: ${path}`);
    }
    Bun.sleepSync(REGISTRY_LOCK_RETRY_MS);
  }
}

function mutateRegistry<T>(
  paths: VaultRegistryPaths,
  mutation: (entries: VaultRegistryEntry[]) => { value: T; changed: boolean },
): T {
  const lock = acquireRegistryLock(paths);
  try {
    const entries = readRegistry(paths);
    const result = mutation(entries);
    if (result.changed) {
      lock.assertOwned();
      writeRegistry(entries, paths);
    }
    return result.value;
  } finally {
    lock.release();
  }
}

function validatedRootedEntry(
  entry: VaultRegistryEntry,
  paths: VaultRegistryPaths,
): VaultRegistryEntry & { root: string } {
  const parsed = parseEntry(entry);
  if (!parsed?.root || parsed.requiresRepair) {
    throw new Error(`Invalid rooted Vault registry entry for slug "${entry.slug}"`);
  }
  assertRootOutsideMain(parsed.root, paths);
  return parsed as VaultRegistryEntry & { root: string };
}

function assertUniqueRoot(
  entries: VaultRegistryEntry[],
  slug: string,
  root: string,
): void {
  const key = rootComparisonKey(root);
  const duplicate = entries.find((entry) => entry.slug !== slug && entry.root && rootComparisonKey(entry.root) === key);
  if (duplicate) {
    throw new VaultFolderError(`Vault root is already registered to "${duplicate.slug}"`);
  }
}

function readVaultManifest(root: string): VaultManifest {
  const path = join(root, VAULT_MANIFEST_FILENAME);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new VaultFolderError(`Folder is not a marked Vault: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultFolderError(`Invalid Vault manifest: ${path}`);
  }
  const manifest = value as Record<string, unknown>;
  const slug = typeof manifest.slug === "string" ? normalizeInstanceName(manifest.slug) : null;
  if (manifest.version !== VAULT_MANIFEST_VERSION || !slug || slug === "default" || !isTimestamp(manifest.createdAt)) {
    throw new VaultFolderError(`Invalid or unsupported Vault manifest: ${path}`);
  }
  return { version: VAULT_MANIFEST_VERSION, slug, createdAt: manifest.createdAt };
}

function prepareVaultRoot(
  root: string,
  slug: string,
  mode: VaultRootMode,
  now: number,
): VaultManifest {
  if (mode === "register") {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new VaultFolderError("Existing Vault folder does not exist or is not a directory");
    }
    const manifest = readVaultManifest(root);
    if (manifest.slug !== slug) {
      throw new VaultFolderError(`Vault manifest belongs to "${manifest.slug}", not "${slug}"`);
    }
    return manifest;
  }

  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) throw new VaultFolderError("Vault root must be a directory");
    if (readdirSync(root).length > 0) {
      throw new VaultFolderError("Choose an empty folder, or register an existing marked Vault");
    }
  } else {
    mkdirSync(root, { recursive: true });
  }
  const manifest: VaultManifest = { version: VAULT_MANIFEST_VERSION, slug, createdAt: now };
  writeFileSync(join(root, VAULT_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  writeVaultPolicy(DENY_ALL_POLICY, { writableRoot: root, instance: slug });
  return manifest;
}

export function listVaults(paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry[] {
  return readRegistry(paths);
}

export function getVault(slug: string, paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry | null {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") return null;
  return readRegistry(paths).find((entry) => entry.slug === normalized) ?? null;
}

/** Low-level rooted upsert used by migration/control-plane code. */
export function registerVault(entry: VaultRegistryEntry, paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry {
  const nextEntry = validatedRootedEntry(entry, paths);
  return mutateRegistry(paths, (entries) => {
    assertUniqueRoot(entries, nextEntry.slug, nextEntry.root);
    const index = entries.findIndex((candidate) => candidate.slug === nextEntry.slug);
    if (index === -1) entries.push(nextEntry);
    else entries[index] = nextEntry;
    return { value: nextEntry, changed: true };
  });
}

export function updateVault(
  slug: string,
  updates: VaultRegistryUpdate,
  paths: VaultRegistryPaths = APP_PATHS,
): VaultRegistryEntry | null {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") return null;
  return mutateRegistry(paths, (entries) => {
    const index = entries.findIndex((candidate) => candidate.slug === normalized);
    if (index === -1) return { value: null, changed: false };
    const current = entries[index]!;
    if (current.requiresRepair && updates.autostart === true) {
      throw new VaultFolderError(`Vault "${normalized}" must be repaired before autostart can be enabled`);
    }
    const next = parseEntry({ ...current, ...updates, slug: normalized });
    if (!next) throw new Error(`Invalid Vault registry update for slug "${slug}"`);
    entries[index] = next;
    return { value: next, changed: true };
  });
}

export function touchVault(
  slug: string,
  now = Date.now(),
  paths: VaultRegistryPaths = APP_PATHS,
): VaultRegistryEntry | null {
  return updateVault(slug, { lastOpenedAt: now }, paths);
}

export function removeVault(slug: string, paths: VaultRegistryPaths = APP_PATHS): boolean {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") return false;
  return mutateRegistry(paths, (entries) => {
    const index = entries.findIndex((entry) => entry.slug === normalized);
    if (index === -1) return { value: false, changed: false };
    entries.splice(index, 1);
    return { value: true, changed: true };
  });
}

export function requireRegisteredVault(
  slug: string,
  paths: VaultRegistryPaths = APP_PATHS,
): VaultRegistryEntry & { root: string } {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") throw new Error(`Invalid named Vault slug "${slug}"`);
  const entry = getVault(normalized, paths);
  if (!entry) throw new Error(`Vault "${normalized}" is not registered; register it in Modus first`);
  if (!entry.root || entry.requiresRepair) {
    throw new Error(`Vault "${normalized}" has a legacy registration; choose a folder in Modus to repair it`);
  }
  const manifest = readVaultManifest(entry.root);
  if (manifest.slug !== normalized) {
    throw new VaultFolderError(`Vault manifest belongs to "${manifest.slug}", not "${normalized}"`);
  }
  return entry as VaultRegistryEntry & { root: string };
}

function claimVaultRoot(
  input: VaultRootRegistration,
  repair: boolean,
  paths: VaultRegistryPaths,
  now: number,
): VaultRegistryEntry {
  const slug = normalizeInstanceName(input.slug);
  if (!slug || slug === "default") throw new Error(`Invalid or reserved Vault slug "${input.slug}"`);
  const root = canonicalVaultRoot(input.root);
  assertRootOutsideMain(root, paths);
  return mutateRegistry(paths, (entries) => {
    const index = entries.findIndex((entry) => entry.slug === slug);
    if (repair) {
      if (index === -1) throw new Error(`Vault "${slug}" not found`);
      if (!entries[index]!.requiresRepair) throw new VaultAlreadyExistsError(slug);
    } else if (index !== -1) {
      throw new VaultAlreadyExistsError(slug);
    }
    assertUniqueRoot(entries, slug, root);
    const manifest = prepareVaultRoot(root, slug, input.mode, now);
    const current = index === -1 ? undefined : entries[index];
    const entry = validatedRootedEntry({
      slug,
      ...(input.name !== undefined
        ? { name: input.name }
        : current?.name !== undefined ? { name: current.name } : {}),
      root,
      createdAt: current?.createdAt ?? manifest.createdAt,
      autostart: false,
      ...(current?.lastOpenedAt !== undefined ? { lastOpenedAt: current.lastOpenedAt } : {}),
    }, paths);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    return { value: entry, changed: true };
  });
}

export function createVault(
  input: VaultRootRegistration,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  return claimVaultRoot(input, false, paths, now);
}

export function repairVaultRegistration(
  input: VaultRootRegistration,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  return claimVaultRoot(input, true, paths, now);
}
