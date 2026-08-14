import { describe, expect, test } from "bun:test";
import { join, resolve } from "path";
import { resolveAppPaths } from "../app-paths";

describe("app path contract", () => {
  test("places writable production state under the Modus home", () => {
    const paths = resolveAppPaths({
      env: {},
      homeDir: "C:/Users/tester",
      sourceResourcesDir: "D:/modus/harness",
      systemTempDir: "C:/Temp",
    });
    expect(paths.modusHome).toBe(resolve("C:/Users/tester/.modus"));
    expect(paths.dataDir).toBe(join(paths.modusHome, "data"));
    expect(paths.logsDir).toBe(join(paths.modusHome, "logs"));
    expect(paths.resourcesDir).toBe(resolve("D:/modus/harness"));
  });

  test("scopes writable runtime roots by instance while preserving resources", () => {
    const paths = resolveAppPaths({
      env: { MODUS_HOME: "D:/state/modus", MODUS_INSTANCE: "dev" },
      sourceResourcesDir: "D:/app/resources",
    });
    expect(paths.dataDir).toBe(resolve("D:/state/modus/dev/data"));
    expect(paths.runtimeDir).toBe(resolve("D:/state/modus/dev/runtime"));
    expect(paths.resourcesDir).toBe(resolve("D:/app/resources"));
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

  test("rejects an instance name that could escape its root", () => {
    expect(() => resolveAppPaths({ env: { MODUS_INSTANCE: "../other" } })).toThrow();
  });
});
