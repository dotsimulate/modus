import { readFileSync } from "node:fs";
import { join, resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  deriveVaultSlug,
  locationForVaultSwitch,
  normalizeVaultSlug,
  restoreVaultLocation,
  vaultDisplayName,
  vaultPolicyReceipt,
  vaultRegistrationState,
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

  test("requires an explicit folder and describes initialize versus register", () => {
    expect(vaultRegistrationState({
      name: "Private",
      slug: "private",
      root: "",
      mode: "initialize",
    })).toMatchObject({ ready: false, error: "Choose a local folder for this Vault." });

    expect(vaultRegistrationState({
      name: "Private",
      slug: "private",
      root: "D:/vaults/private",
      mode: "initialize",
    })).toEqual({ ready: true, slug: "private", action: "create, start, and enter" });

    expect(vaultRegistrationState({
      name: "Private",
      slug: "private",
      root: "D:/vaults/private",
      mode: "register",
    })).toEqual({ ready: true, slug: "private", action: "register, start, and enter" });
  });

  test("repairs a legacy slug without requiring a new display name", () => {
    expect(vaultRegistrationState({
      name: "",
      slug: "legacy",
      root: "D:/vaults/legacy",
      mode: "initialize",
      repair: true,
    })).toEqual({ ready: true, slug: "legacy", action: "repair registration, start, and enter" });
  });
});

describe("desktop Vault lifecycle ownership", () => {
  const uiRoot = resolveTestSourceDir(import.meta.dir, "..", "..", "ui", "src");

  test("uses the desktop registry bridge instead of whichever backend is active", () => {
    const source = readFileSync(join(uiRoot, "components", "DesktopVaultManager.tsx"), "utf8");
    for (const operation of [
      "listDesktopVaults",
      "createDesktopVault",
      "repairDesktopVault",
      "updateDesktopVault",
      "getDesktopVaultPolicy",
      "chooseDesktopVaultFolder",
    ]) {
      expect(source).toContain(operation);
    }
    for (const forbidden of [
      "modus.listVaults",
      "modus.createVault",
      "modus.updateVault",
      "modus.getVaultPolicy",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  test("maps every registry operation to a desktop command", () => {
    const source = readFileSync(join(uiRoot, "desktopBridge.ts"), "utf8");
    for (const command of [
      "desktop_list_vaults",
      "desktop_create_vault",
      "desktop_repair_vault",
      "desktop_update_vault",
      "desktop_vault_policy",
      "desktop_choose_vault_folder",
    ]) {
      expect(source).toContain(command);
    }
  });
});
