import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, normalize, resolve } from "path";
import { resolveDatabasePath } from "../database-paths";

describe("resolveDatabasePath", () => {
  test("uses an explicit isolated data directory", () => {
    const dataDir = join(tmpdir(), "modus-path-test", "explicit");
    expect(resolveDatabasePath("harness.db", { MODUS_DATA_DIR: dataDir })).toBe(
      join(resolve(dataDir), "harness.db"),
    );
  });

  test("keeps test workers out of the source tree by default", () => {
    const path = resolveDatabasePath("activity.db", { NODE_ENV: "test" });
    expect(path).toBe(join(tmpdir(), "modus-tests", String(process.pid), "activity.db"));
    expect(isAbsolute(path)).toBe(true);
    expect(normalize(path).startsWith(normalize(resolveTestSourceDir(import.meta.dir, "..")))).toBe(false);
  });

  test("uses the instance-scoped user data directory in production", () => {
    const root = join(tmpdir(), "modus-path-test", "home");
    const resources = join(tmpdir(), "modus-path-test", "empty-resources");
    expect(resolveDatabasePath("terminal.db", {
      MODUS_HOME: root,
      MODUS_INSTANCE: "dev",
    }, { sourceResourcesDir: resources })).toBe(join(resolve(root), "dev", "data", "terminal.db"));
  });

  test("refuses to create a blank user database while a legacy database awaits migration", () => {
    const root = join(tmpdir(), "modus-path-test", crypto.randomUUID());
    const resources = join(root, "resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(resources, "harness.db"), "legacy database placeholder");

    expect(() => resolveDatabasePath(
      "harness.db",
      { MODUS_HOME: join(root, "home") },
      { sourceResourcesDir: resources },
    )).toThrow("Legacy database migration required");
  });
});
