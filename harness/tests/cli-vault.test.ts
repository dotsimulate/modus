import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
  resolveCliVault,
  vaultDaemonLogFile,
  vaultEnvironment,
  vaultStateFiles,
  vaultTokenFile,
} from "../cli-vault";

describe("resolveCliVault", () => {
  test("defaults to the implicit Vault and normalizes the reserved default name", () => {
    expect(resolveCliVault([])).toBeNull();
    expect(resolveCliVault(["--instance", "default"])).toBeNull();
    expect(resolveCliVault(["--instance", "DEFAULT"])).toBeNull();
    expect(resolveCliVault([], " default ")).toBeNull();
  });

  test("prefers a validated flag over the environment", () => {
    expect(resolveCliVault(["--instance", "private"], "work")).toBe("private");
    expect(resolveCliVault(["--instance=private"])).toBe("private");
    expect(resolveCliVault(["--instance", "Private"])).toBe("private");
  });

  test("rejects missing and invalid instance names", () => {
    expect(() => resolveCliVault(["--instance"])).toThrow("requires a Vault slug");
    expect(() => resolveCliVault(["--instance="])).toThrow("requires a Vault slug");
    expect(() => resolveCliVault(["--instance", "../escape"])).toThrow("Invalid Vault slug");
    expect(() => resolveCliVault([], ".")).toThrow("Invalid Vault slug");
  });
});

describe("vaultStateFiles", () => {
  test("preserves default filenames and puts each named Vault inside its own root", () => {
    const configDir = join("tmp", "modus-config");
    const privateRoot = join("D:", "vaults", "private");
    const workRoot = join("E:", "portable", "work");
    expect(vaultStateFiles(configDir, null)).toEqual({
      pidFile: join(configDir, "harness.pid"),
      portFile: join(configDir, "harness.port"),
    });
    expect(vaultStateFiles(configDir, "private", privateRoot)).toEqual({
      pidFile: join(privateRoot, "runtime", "harness.pid"),
      portFile: join(privateRoot, "runtime", "harness.port"),
    });
    expect(vaultStateFiles(configDir, "work", workRoot)).toEqual({
      pidFile: join(workRoot, "runtime", "harness.pid"),
      portFile: join(workRoot, "runtime", "harness.port"),
    });
    expect(vaultTokenFile(configDir, "private", privateRoot))
      .toBe(join(privateRoot, "runtime", "harness-token"));
    expect(() => vaultStateFiles(configDir, "private")).toThrow("missing its registered folder root");
  });
});

describe("vaultEnvironment", () => {
  test("sets a complete named root contract and clears inherited identity for Main", () => {
    const privateRoot = join("D:", "vaults", "private");
    const parent = {
      MODUS_INSTANCE: "inherited",
      MODUS_VAULT_ROOT: "old-root",
      MODUS_DATA_DIR: "main-data",
      MODUS_LOGS_DIR: "main-logs",
      MODUS_RUNTIME_DIR: "main-runtime",
      MODUS_CACHE_DIR: "main-cache",
      KEEP: "yes",
    };
    expect(vaultEnvironment(parent, "private", privateRoot)).toEqual({
      MODUS_INSTANCE: "private",
      MODUS_VAULT_ROOT: privateRoot,
      MODUS_HOME: privateRoot,
      HARNESS_SECRETS_FILE: join(privateRoot, "secrets.env"),
      KEEP: "yes",
    });
    expect(vaultEnvironment(parent, null)).toEqual({
      MODUS_DATA_DIR: "main-data",
      MODUS_LOGS_DIR: "main-logs",
      MODUS_RUNTIME_DIR: "main-runtime",
      MODUS_CACHE_DIR: "main-cache",
      KEEP: "yes",
    });
    expect(parent.MODUS_INSTANCE).toBe("inherited");
  });
});

describe("vaultDaemonLogFile", () => {
  test("preserves the legacy default log and scopes named daemon output", () => {
    expect(vaultDaemonLogFile("harness/harness.log", null))
      .toBe("harness/harness.log");
    expect(vaultDaemonLogFile("harness/harness.log", "private", "home/private"))
      .toBe(join("home/private", "logs", "harness.log"));
  });
});
