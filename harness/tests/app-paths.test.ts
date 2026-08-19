import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import {
  isPathWithinRoot,
  isValidInstanceName,
  normalizeInstanceName,
  resolveAppPaths,
} from "../app-paths";

describe("app path contract", () => {
  test("places writable production state under the Modus home", () => {
    const paths = resolveAppPaths({
      env: {},
      homeDir: "C:/Users/tester",
      sourceResourcesDir: "D:/modus/harness",
      systemTempDir: "C:/Temp",
    });
    expect(paths.modusHome).toBe(resolve("C:/Users/tester/.modus"));
    expect(paths.writableRoot).toBe(paths.modusHome);
    expect(paths.dataDir).toBe(join(paths.modusHome, "data"));
    expect(paths.logsDir).toBe(join(paths.modusHome, "logs"));
    expect(paths.resourcesDir).toBe(resolve("D:/modus/harness"));
  });

  test("uses an explicit named Vault root without appending the slug", () => {
    const paths = resolveAppPaths({
      env: {
        MODUS_HOME: "D:/state/main",
        MODUS_INSTANCE: "dev",
        MODUS_VAULT_ROOT: "D:/vaults/my-work",
      },
      sourceResourcesDir: "D:/app/resources",
    });
    expect(paths.modusHome).toBe(resolve("D:/vaults/my-work"));
    expect(paths.writableRoot).toBe(resolve("D:/vaults/my-work"));
    expect(paths.dataDir).toBe(resolve("D:/vaults/my-work/data"));
    expect(paths.runtimeDir).toBe(resolve("D:/vaults/my-work/runtime"));
    expect(paths.tempDir).toBe(resolve("D:/vaults/my-work/tmp"));
    expect(paths.resourcesDir).toBe(resolve("D:/app/resources"));
  });

  test("canonicalizes instance identity without deriving storage from it", () => {
    const paths = resolveAppPaths({
      env: {
        MODUS_INSTANCE: " Private ",
        MODUS_VAULT_ROOT: "D:/vaults/chosen-folder",
      },
      sourceResourcesDir: "D:/app/resources",
    });
    expect(normalizeInstanceName(" Private ")).toBe("private");
    expect(paths.instance).toBe("private");
    expect(paths.writableRoot).toBe(resolve("D:/vaults/chosen-folder"));
    expect(resolveAppPaths({ env: { MODUS_INSTANCE: " DEFAULT " } }).instance).toBeNull();
  });

  test("rejects a named Vault without an explicit absolute root", () => {
    expect(() => resolveAppPaths({
      env: { MODUS_HOME: "D:/state/main", MODUS_INSTANCE: "private" },
    })).toThrow("MODUS_VAULT_ROOT");
    expect(() => resolveAppPaths({
      env: { MODUS_INSTANCE: "private", MODUS_VAULT_ROOT: "relative/vault" },
    })).toThrow("absolute");
  });

  test("allows named directory overrides only below the registered root", () => {
    const paths = resolveAppPaths({
      env: {
        MODUS_INSTANCE: "private",
        MODUS_VAULT_ROOT: "D:/vaults/private",
        MODUS_DATA_DIR: "D:/vaults/private/custom/data",
        MODUS_LOGS_DIR: "D:/vaults/private/custom/logs",
        MODUS_RUNTIME_DIR: "D:/vaults/private/custom/runtime",
        MODUS_CACHE_DIR: "D:/vaults/private/custom/cache",
      },
    });
    expect(paths.dataDir).toBe(resolve("D:/vaults/private/custom/data"));
    for (const [key, value] of [
      ["MODUS_DATA_DIR", "D:/shared/data"],
      ["MODUS_LOGS_DIR", "D:/vaults/private/../sibling/logs"],
      ["MODUS_RUNTIME_DIR", "D:/vaults/private"],
      ["MODUS_CACHE_DIR", "D:/vaults/private-cache"],
      ...(process.platform === "win32" ? [["MODUS_RUNTIME_DIR", "d:/VAULTS/PRIVATE"]] : []),
    ]) {
      expect(() => resolveAppPaths({
        env: {
          MODUS_INSTANCE: "private",
          MODUS_VAULT_ROOT: "D:/vaults/private",
          [key]: value,
        },
      }), key).toThrow("inside MODUS_VAULT_ROOT");
    }
  });

  test("checks descendant paths with Windows and POSIX semantics", () => {
    expect(isPathWithinRoot("C:\\Vaults\\Private", "c:\\vaults\\private\\data", "win32")).toBe(true);
    expect(isPathWithinRoot("C:\\Vaults\\Private", "C:\\Vaults\\Private", "win32")).toBe(true);
    expect(isPathWithinRoot("C:\\Vaults\\Private", "C:\\Vaults\\Private-2\\data", "win32")).toBe(false);
    expect(isPathWithinRoot("C:\\Vaults\\Private", "D:\\Vaults\\Private\\data", "win32")).toBe(false);
    expect(isPathWithinRoot("/vaults/private", "/vaults/private/data", "posix")).toBe(true);
    expect(isPathWithinRoot("/vaults/private", "/vaults/private", "posix")).toBe(true);
    expect(isPathWithinRoot("/vaults/private", "/vaults/private-2/data", "posix")).toBe(false);
    expect(isPathWithinRoot("/vaults/private", "/vaults/private/../sibling", "posix")).toBe(false);
  });

  // The `\\?\` extended-length prefix is Windows-only path semantics; on POSIX
  // the backslashes are ordinary filename characters and resolve() never yields
  // such a prefix, so this contract only applies on Windows.
  test.skipIf(process.platform !== "win32")(
    "strips the Windows extended-length prefix from configured paths",
    () => {
      const paths = resolveAppPaths({
        env: { MODUS_RESOURCES_DIR: "\\\\?\\C:\\Apps\\Modus\\modus" },
      });
      expect(paths.resourcesDir).toBe(resolve("C:\\Apps\\Modus\\modus"));
    },
  );

  test("exposes the reusable instance-name contract", () => {
    expect(isValidInstanceName("dev-1.foo_bar")).toBe(true);
    expect(isValidInstanceName("default")).toBe(true);
    expect(isValidInstanceName("")).toBe(false);
    expect(isValidInstanceName("../other")).toBe(false);
    expect(isValidInstanceName("two words")).toBe(false);
    expect(isValidInstanceName(".")).toBe(false);
    expect(isValidInstanceName("..")).toBe(false);
  });

  test("rejects an instance name that could escape or collapse its root", () => {
    expect(() => resolveAppPaths({ env: { MODUS_INSTANCE: "../other" } })).toThrow();
    expect(() => resolveAppPaths({ env: { MODUS_INSTANCE: "." } })).toThrow();
    expect(() => resolveAppPaths({ env: { MODUS_INSTANCE: ".." } })).toThrow();
  });
});
