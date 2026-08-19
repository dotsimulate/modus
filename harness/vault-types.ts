export type VaultPolicyRule =
  | { mode: "allow-all" }
  | { mode: "deny"; allow: string[] };

export type VaultPolicy = {
  plugins: VaultPolicyRule;
  projectAutomation: VaultPolicyRule;
  channels: VaultPolicyRule;
};

export type NamedVault = {
  slug: string;
  name?: string;
  /** Canonical absolute folder root. Missing only on a legacy-invalid registry row. */
  root?: string;
  /** True when an old slug-only row must be repaired before it can start. */
  requiresRepair?: boolean;
  createdAt: number;
  autostart?: boolean;
  lastOpenedAt?: number;
};

export type VaultListItem = {
  /** Null is Main, the implicit default Vault with no registry row. */
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
