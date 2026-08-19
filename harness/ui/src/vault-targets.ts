export type VaultStorage = Pick<Storage, "getItem" | "setItem">;

const LAST_LOCATION_PREFIX = "modus:vault-last-location:v1:";

export function normalizeVaultSlug(value: string): string | null {
  const slug = value.trim().toLowerCase();
  if (!slug || slug === "default" || slug === "." || slug === "..") return null;
  return /^[a-z0-9._-]+$/.test(slug) ? slug : null;
}

export function deriveVaultSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}

export function vaultTargetId(slug: string | null): string {
  return slug ? `vault:${slug}` : "local";
}

export function vaultDisplayName(slug: string | null, name?: string): string {
  return slug ? name?.trim() || slug : "Main";
}

function lastLocationKey(targetId: string): string {
  return `${LAST_LOCATION_PREFIX}${encodeURIComponent(targetId)}`;
}

function safeHash(value: string | null): string {
  if (!value || value === "#") return "";
  return value.startsWith("#") ? value : "";
}

export function rememberVaultLocation(
  targetId: string,
  hash: string,
  storage: VaultStorage = localStorage,
): void {
  storage.setItem(lastLocationKey(targetId), safeHash(hash));
}

export function restoreVaultLocation(
  targetId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): string {
  return safeHash(storage.getItem(lastLocationKey(targetId)));
}

export function locationForVaultSwitch(
  currentTargetId: string,
  nextTargetId: string,
  currentHash: string,
  storage: VaultStorage = localStorage,
): string {
  rememberVaultLocation(currentTargetId, currentHash, storage);
  return restoreVaultLocation(nextTargetId, storage);
}

type PolicyRule = { mode: "allow-all" } | { mode: "deny"; allow: string[] };
type VaultPolicyLike = {
  plugins: PolicyRule;
  projectAutomation: PolicyRule;
  channels: PolicyRule;
};

export function vaultPolicyReceipt(policy: VaultPolicyLike): string {
  const rules = [policy.plugins, policy.projectAutomation, policy.channels];
  if (rules.every((rule) => rule.mode === "deny" && rule.allow.length === 0)) {
    return "Restricted: plugins, project automation, and channels are denied by default.";
  }
  return "Custom policy: review the Vault policy before relying on its restrictions.";
}
