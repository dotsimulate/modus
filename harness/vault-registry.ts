/** Shared registry of named Vaults. Registry removal never removes Vault data. */

import { randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { APP_PATHS, normalizeInstanceName, type AppPaths } from "./app-paths";
import { homeVaultsJsonPath } from "./modus-home";
import { DENY_ALL_POLICY, writeVaultPolicy } from "./vault-policy";

export type VaultRegistryEntry = {
  slug: string;
  name?: string;
  createdAt: number;
  autostart?: boolean;
  lastOpenedAt?: number;
};

export type VaultRegistryPaths = Pick<AppPaths, "modusHome">;

type VaultsFile = {
  vaults: VaultRegistryEntry[];
};

export type VaultRegistryUpdate = {
  name?: string;
  autostart?: boolean;
  lastOpenedAt?: number;
};

export class VaultAlreadyExistsError extends Error {
  constructor(readonly slug: string) {
    super(`Vault "${slug}" already exists`);
    this.name = "VaultAlreadyExistsError";
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
  return {
    slug,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    createdAt: entry.createdAt,
    ...(entry.autostart !== undefined ? { autostart: entry.autostart } : {}),
    ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
  };
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
    return parsed;
  } catch {
    warnCorrupt(path);
    return [];
  }
}

function writeRegistry(entries: VaultRegistryEntry[], paths: VaultRegistryPaths): void {
  const path = registryPath(paths);
  mkdirSync(dirname(path), { recursive: true });
  const value: VaultsFile = { vaults: entries };
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
      if (fsErrorCode(error) !== "EEXIST") throw error;
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

function validatedEntry(entry: VaultRegistryEntry): VaultRegistryEntry {
  const parsed = parseEntry(entry);
  if (!parsed) throw new Error(`Invalid Vault registry entry for slug "${entry.slug}"`);
  return parsed;
}

export function listVaults(paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry[] {
  return readRegistry(paths);
}

export function getVault(slug: string, paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry | null {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") return null;
  return readRegistry(paths).find((entry) => entry.slug === normalized) ?? null;
}

export function registerVault(entry: VaultRegistryEntry, paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry {
  const nextEntry = validatedEntry(entry);
  return mutateRegistry(paths, (entries) => {
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
    const next = validatedEntry({ ...entries[index]!, ...updates, slug: normalized });
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

/** Register a named Vault discovered through a headless CLI start. */
export function ensureVaultRegistered(
  slug: string,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  const nextEntry = validatedEntry({ slug, createdAt: now, autostart: false });
  return mutateRegistry(paths, (entries) => {
    const existing = entries.find((entry) => entry.slug === nextEntry.slug);
    if (existing) return { value: existing, changed: false };
    entries.push(nextEntry);
    return { value: nextEntry, changed: true };
  });
}

export function createVault(
  slug: string,
  name?: string,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") {
    throw new Error(`Invalid or reserved Vault slug "${slug}"`);
  }
  const entry = validatedEntry({ slug: normalized, ...(name !== undefined ? { name } : {}), createdAt: now });
  mutateRegistry(paths, (entries) => {
    if (entries.some((candidate) => candidate.slug === normalized)) {
      throw new VaultAlreadyExistsError(normalized);
    }
    entries.push(entry);
    return { value: undefined, changed: true };
  });
  writeVaultPolicy(DENY_ALL_POLICY, {
    writableRoot: join(paths.modusHome, normalized),
    instance: normalized,
  });
  return entry;
}
