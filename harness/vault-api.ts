/** Pure Vault API operations, separated from HTTP so their validation is testable
 * without starting a backend or binding a port. */

import { APP_PATHS, normalizeInstanceName, type AppPaths } from "./app-paths";
import {
  createVault,
  listVaults,
  repairVaultRegistration,
  requireRegisteredVault,
  updateVault,
  VaultAlreadyExistsError,
  VaultFolderError,
  type VaultRegistryEntry,
  type VaultRootMode,
} from "./vault-registry";
import {
  getVaultPolicy,
  parseVaultPolicy,
  writeVaultPolicy,
  type VaultPolicy,
  type VaultPolicyPaths,
} from "./vault-policy";

export type VaultApiPaths = Pick<AppPaths, "modusHome" | "instance">;

export type VaultListItem = {
  slug: string | null;
  name?: string;
  root?: string;
  requiresRepair?: boolean;
  createdAt?: number;
  autostart?: boolean;
  lastOpenedAt?: number;
};

export type VaultListResponse = {
  current: string | null;
  vaults: VaultListItem[];
};

export type VaultCreateInput = {
  slug?: unknown;
  name?: unknown;
  root?: unknown;
  mode?: unknown;
};

export type VaultUpdateInput = {
  name?: unknown;
  autostart?: unknown;
};

export type VaultApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 403 | 404 | 409; error: string };

function invalid<T>(status: 400 | 403 | 404 | 409, error: string): VaultApiResult<T> {
  return { ok: false, status, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function listVaultsForApi(paths: VaultApiPaths = APP_PATHS): VaultListResponse {
  if (paths.instance) {
    return { current: paths.instance, vaults: [] };
  }
  return {
    current: paths.instance,
    vaults: [{ slug: null, name: "Main", root: paths.modusHome }, ...listVaults(paths)],
  };
}

function mainOnly<T>(paths: VaultApiPaths): VaultApiResult<T> | null {
  return paths.instance
    ? invalid(403, "Vault registry control is available only from Main")
    : null;
}

function parseRootMode(value: unknown): VaultRootMode | null {
  return value === "initialize" || value === "register" ? value : null;
}

export function createVaultForApi(
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
  now = Date.now(),
): VaultApiResult<VaultRegistryEntry> {
  const denied = mainOnly<VaultRegistryEntry>(paths);
  if (denied) return denied;
  if (!isObject(value)) return invalid(400, "body must be an object");
  const input = value as VaultCreateInput;
  if (typeof input.slug !== "string" || !input.slug) return invalid(400, "slug is required");
  const slug = normalizeInstanceName(input.slug);
  if (!slug || slug === "default") {
    return invalid(400, `Invalid or reserved Vault slug "${input.slug}"`);
  }
  if (input.name !== undefined && typeof input.name !== "string") {
    return invalid(400, "name must be a string");
  }
  if (typeof input.root !== "string" || !input.root.trim()) return invalid(400, "root is required");
  const mode = parseRootMode(input.mode);
  if (!mode) return invalid(400, "mode must be initialize or register");
  try {
    return {
      ok: true,
      value: createVault({
        slug,
        root: input.root,
        mode,
        ...(input.name !== undefined ? { name: input.name as string } : {}),
      }, paths, now),
    };
  } catch (error) {
    if (error instanceof VaultAlreadyExistsError) return invalid(409, error.message);
    if (error instanceof VaultFolderError) return invalid(409, error.message);
    throw error;
  }
}

export function repairVaultForApi(
  slug: string,
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
  now = Date.now(),
): VaultApiResult<VaultRegistryEntry> {
  const denied = mainOnly<VaultRegistryEntry>(paths);
  if (denied) return denied;
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") return invalid(400, `Invalid or reserved Vault slug "${slug}"`);
  if (!isObject(value)) return invalid(400, "body must be an object");
  if (typeof value.root !== "string" || !value.root.trim()) return invalid(400, "root is required");
  const mode = parseRootMode(value.mode);
  if (!mode) return invalid(400, "mode must be initialize or register");
  if (value.name !== undefined && typeof value.name !== "string") return invalid(400, "name must be a string");
  try {
    return {
      ok: true,
      value: repairVaultRegistration({
        slug: normalized,
        root: value.root,
        mode,
        ...(value.name !== undefined ? { name: value.name } : {}),
      }, paths, now),
    };
  } catch (error) {
    if (error instanceof VaultAlreadyExistsError || error instanceof VaultFolderError) {
      return invalid(409, error.message);
    }
    if (error instanceof Error && error.message.endsWith("not found")) return invalid(404, error.message);
    throw error;
  }
}

export function updateVaultForApi(
  slug: string,
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
): VaultApiResult<VaultRegistryEntry> {
  const denied = mainOnly<VaultRegistryEntry>(paths);
  if (denied) return denied;
  const normalized = normalizeInstanceName(slug);
  if (!normalized || normalized === "default") {
    return invalid(400, `Invalid or reserved Vault slug "${slug}"`);
  }
  if (!isObject(value)) return invalid(400, "body must be an object");
  const input = value as VaultUpdateInput;
  if (input.name !== undefined && typeof input.name !== "string") {
    return invalid(400, "name must be a string");
  }
  if (input.autostart !== undefined && typeof input.autostart !== "boolean") {
    return invalid(400, "autostart must be a boolean");
  }
  const updated = updateVault(normalized, {
    ...(input.name !== undefined ? { name: input.name as string } : {}),
    ...(input.autostart !== undefined ? { autostart: input.autostart as boolean } : {}),
  }, paths);
  return updated
    ? { ok: true, value: updated }
    : invalid(404, `Vault "${normalized}" not found`);
}

function policyScope(slug: string, paths: VaultApiPaths): VaultApiResult<VaultPolicyPaths> {
  const denied = mainOnly<VaultPolicyPaths>(paths);
  if (denied) return denied;
  const normalized = normalizeInstanceName(slug);
  if (normalized === "default") {
    return { ok: true, value: { writableRoot: paths.modusHome, instance: null } };
  }
  if (!normalized) {
    return invalid(404, `Vault "${slug}" not found`);
  }
  let entry: ReturnType<typeof requireRegisteredVault>;
  try {
    entry = requireRegisteredVault(normalized, paths);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not registered")) return invalid(404, `Vault "${slug}" not found`);
    return invalid(409, message);
  }
  return {
    ok: true,
    value: { writableRoot: entry.root, instance: normalized },
  };
}

export function getVaultPolicyForApi(
  slug: string,
  paths: VaultApiPaths = APP_PATHS,
): VaultApiResult<VaultPolicy> {
  const scope = policyScope(slug, paths);
  if (!scope.ok) return scope;
  return { ok: true, value: getVaultPolicy(scope.value) };
}

export function setVaultPolicyForApi(
  slug: string,
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
): VaultApiResult<VaultPolicy> {
  const scope = policyScope(slug, paths);
  if (!scope.ok) return scope;
  const policy = parseVaultPolicy(value);
  if (!policy) return invalid(400, "Invalid Vault policy");
  writeVaultPolicy(policy, scope.value);
  return { ok: true, value: policy };
}
