import { describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { isAbsolute, join, normalize, resolve } from "path";
import { resolveDatabasePath } from "./database-paths";

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
    expect(normalize(path).startsWith(normalize(import.meta.dir))).toBe(false);
  });

  test("preserves the legacy production location before path migration", () => {
    expect(resolveDatabasePath("terminal.db", {})).toBe(join(import.meta.dir, "terminal.db"));
  });
});
