import { describe, expect, test } from "bun:test";
import {
  deriveVaultSlug,
  locationForVaultSwitch,
  normalizeVaultSlug,
  restoreVaultLocation,
  vaultDisplayName,
  vaultPolicyReceipt,
  vaultTargetId,
} from "../../ui/src/vault-targets";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("Vault target logic", () => {
  test("derives an editable canonical slug from the display name", () => {
    expect(deriveVaultSlug("  Résumé / Private Work  ")).toBe("resume-private-work");
    expect(normalizeVaultSlug(" Private_Work ")).toBe("private_work");
    expect(normalizeVaultSlug("default")).toBeNull();
    expect(normalizeVaultSlug("two words")).toBeNull();
  });

  test("presents Main and stable named target identities", () => {
    expect(vaultTargetId(null)).toBe("local");
    expect(vaultTargetId("private")).toBe("vault:private");
    expect(vaultDisplayName(null, "ignored")).toBe("Main");
    expect(vaultDisplayName("private", "Private Work")).toBe("Private Work");
  });

  test("remembers each Vault location and falls back to its home", () => {
    const storage = new MemoryStorage();
    expect(locationForVaultSwitch("local", "vault:private", "#modus-dev/session-1", storage)).toBe("");
    expect(locationForVaultSwitch("vault:private", "local", "#private-profile/page:git", storage))
      .toBe("#modus-dev/session-1");
    expect(restoreVaultLocation("vault:private", storage)).toBe("#private-profile/page:git");
  });

  test("describes deny-all honestly without claiming sandboxing", () => {
    expect(vaultPolicyReceipt({
      plugins: { mode: "deny", allow: [] },
      projectAutomation: { mode: "deny", allow: [] },
      channels: { mode: "deny", allow: [] },
    })).toContain("denied by default");
    expect(vaultPolicyReceipt({
      plugins: { mode: "allow-all" },
      projectAutomation: { mode: "deny", allow: [] },
      channels: { mode: "deny", allow: [] },
    })).toContain("Custom policy");
  });
});
