/** Shared registry of named Vaults. Registry removal never removes Vault data. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { APP_PATHS, isValidInstanceName, type AppPaths } from "./app-paths";
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

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseEntry(value: unknown): VaultRegistryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.slug !== "string" || !isValidInstanceName(entry.slug) || entry.slug === "default") return null;
  if (!isTimestamp(entry.createdAt)) return null;
  if (entry.name !== undefined && typeof entry.name !== "string") return null;
  if (entry.autostart !== undefined && typeof entry.autostart !== "boolean") return null;
  if (entry.lastOpenedAt !== undefined && !isTimestamp(entry.lastOpenedAt)) return null;
  return {
    slug: entry.slug,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    createdAt: entry.createdAt,
    ...(entry.autostart !== undefined ? { autostart: entry.autostart } : {}),
    ...(entry.lastOpenedAt !== undefined ? { lastOpenedAt: entry.lastOpenedAt } : {}),
  };
}

function registryPath(paths: VaultRegistryPaths): string {
  return homeVaultsJsonPath(paths.modusHome);
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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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
  if (!isValidInstanceName(slug) || slug === "default") return null;
  return readRegistry(paths).find((entry) => entry.slug === slug) ?? null;
}

export function registerVault(entry: VaultRegistryEntry, paths: VaultRegistryPaths = APP_PATHS): VaultRegistryEntry {
  const nextEntry = validatedEntry(entry);
  const entries = readRegistry(paths);
  const index = entries.findIndex((candidate) => candidate.slug === nextEntry.slug);
  if (index === -1) entries.push(nextEntry);
  else entries[index] = nextEntry;
  writeRegistry(entries, paths);
  return nextEntry;
}

export function touchVault(
  slug: string,
  now = Date.now(),
  paths: VaultRegistryPaths = APP_PATHS,
): VaultRegistryEntry | null {
  const existing = getVault(slug, paths);
  if (!existing) return null;
  return registerVault({ ...existing, lastOpenedAt: now }, paths);
}

export function removeVault(slug: string, paths: VaultRegistryPaths = APP_PATHS): boolean {
  const entries = readRegistry(paths);
  const next = entries.filter((entry) => entry.slug !== slug);
  if (next.length === entries.length) return false;
  writeRegistry(next, paths);
  return true;
}

/** Register a named Vault discovered through a headless CLI start. */
export function ensureVaultRegistered(
  slug: string,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  const existing = getVault(slug, paths);
  if (existing) return existing;
  return registerVault({ slug, createdAt: now, autostart: false }, paths);
}

export function createVault(
  slug: string,
  name?: string,
  paths: VaultRegistryPaths = APP_PATHS,
  now = Date.now(),
): VaultRegistryEntry {
  if (!isValidInstanceName(slug) || slug === "default") {
    throw new Error(`Invalid or reserved Vault slug "${slug}"`);
  }
  if (getVault(slug, paths)) throw new Error(`Vault "${slug}" already exists`);
  const entry = registerVault({ slug, ...(name !== undefined ? { name } : {}), createdAt: now }, paths);
  writeVaultPolicy(DENY_ALL_POLICY, {
    writableRoot: join(paths.modusHome, slug),
    instance: slug,
  });
  return entry;
}
