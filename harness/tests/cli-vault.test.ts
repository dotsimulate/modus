import { describe, expect, test } from "bun:test";
import { join } from "path";
import { resolveCliVault, vaultDaemonLogFile, vaultEnvironment, vaultStateFiles } from "../cli-vault";

describe("resolveCliVault", () => {
  test("defaults to the implicit Vault and normalizes the reserved default name", () => {
    expect(resolveCliVault([])).toBeNull();
    expect(resolveCliVault(["--instance", "default"])).toBeNull();
    expect(resolveCliVault([], " default ")).toBeNull();
  });

  test("prefers a validated flag over the environment", () => {
    expect(resolveCliVault(["--instance", "private"], "work")).toBe("private");
    expect(resolveCliVault(["--instance=private"])).toBe("private");
  });

  test("rejects missing and invalid instance names", () => {
    expect(() => resolveCliVault(["--instance"])).toThrow("requires a Vault slug");
    expect(() => resolveCliVault(["--instance="])).toThrow("requires a Vault slug");
    expect(() => resolveCliVault(["--instance", "../escape"])).toThrow("Invalid Vault slug");
    expect(() => resolveCliVault([], ".")).toThrow("Invalid Vault slug");
  });
});

describe("vaultStateFiles", () => {
  test("preserves default filenames and scopes named Vaults", () => {
    const configDir = join("tmp", "modus-config");
    expect(vaultStateFiles(configDir, null)).toEqual({
      pidFile: join(configDir, "harness.pid"),
      portFile: join(configDir, "harness.port"),
    });
    expect(vaultStateFiles(configDir, "private")).toEqual({
      pidFile: join(configDir, "harness.private.pid"),
      portFile: join(configDir, "harness.private.port"),
    });
  });
});

describe("vaultEnvironment", () => {
  test("sets a named Vault and clears inherited identity for the default", () => {
    const parent = { MODUS_INSTANCE: "inherited", KEEP: "yes" };
    expect(vaultEnvironment(parent, "private")).toEqual({
      MODUS_INSTANCE: "private",
      KEEP: "yes",
    });
    expect(vaultEnvironment(parent, null)).toEqual({ KEEP: "yes" });
    expect(parent.MODUS_INSTANCE).toBe("inherited");
  });
});

describe("vaultDaemonLogFile", () => {
  test("preserves the legacy default log and scopes named daemon output", () => {
    expect(vaultDaemonLogFile("harness/harness.log", "home/private/logs", null))
      .toBe("harness/harness.log");
    expect(vaultDaemonLogFile("harness/harness.log", "home/private/logs", "private"))
      .toBe(join("home/private/logs", "harness.log"));
  });
});
