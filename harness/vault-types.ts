export type VaultPolicyRule =
  | { mode: "allow-all" }
  | { mode: "deny"; allow: string[] };

export type VaultPolicy = {
  plugins: VaultPolicyRule;
  projectAutomation: VaultPolicyRule;
  channels: VaultPolicyRule;
};
