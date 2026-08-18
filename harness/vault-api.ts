/** Pure Vault API operations, separated from HTTP so their validation is testable
 * without starting a backend or binding a port. */

import { join } from "path";
import { APP_PATHS, normalizeInstanceName, type AppPaths } from "./app-paths";
import {
  createVault,
  getVault,
  listVaults,
  updateVault,
  VaultAlreadyExistsError,
  type VaultRegistryEntry,
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
};

export type VaultUpdateInput = {
  name?: unknown;
  autostart?: unknown;
};

export type VaultApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function invalid<T>(status: 400 | 404 | 409, error: string): VaultApiResult<T> {
  return { ok: false, status, error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function listVaultsForApi(paths: VaultApiPaths = APP_PATHS): VaultListResponse {
  return {
    current: paths.instance,
    vaults: [{ slug: null }, ...listVaults(paths)],
  };
}

export function createVaultForApi(
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
  now = Date.now(),
): VaultApiResult<VaultRegistryEntry> {
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
  try {
    return {
      ok: true,
      value: createVault(slug, input.name as string | undefined, paths, now),
    };
  } catch (error) {
    if (error instanceof VaultAlreadyExistsError) return invalid(409, error.message);
    throw error;
  }
}

export function updateVaultForApi(
  slug: string,
  value: unknown,
  paths: VaultApiPaths = APP_PATHS,
): VaultApiResult<VaultRegistryEntry> {
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
  const normalized = normalizeInstanceName(slug);
  if (normalized === "default") {
    return { ok: true, value: { writableRoot: paths.modusHome, instance: null } };
  }
  if (!normalized || !getVault(normalized, paths)) {
    return invalid(404, `Vault "${slug}" not found`);
  }
  return {
    ok: true,
    value: { writableRoot: join(paths.modusHome, normalized), instance: normalized },
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
