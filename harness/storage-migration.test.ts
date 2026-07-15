import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyStorageMigration,
  planStorageMigration,
  type StorageMigrationLocations,
} from "./storage-migration";

function locations(name: string): StorageMigrationLocations {
  const root = join(tmpdir(), `modus-storage-${name}-${crypto.randomUUID()}`);
  return {
    legacyDir: join(root, "legacy"),
    dataDir: join(root, "home", "data"),
    recordPath: join(root, "home", "data", "migrations", "storage-v1.json"),
  };
}

function createDatabase(path: string, value: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE sample (value TEXT NOT NULL)");
  db.run("INSERT INTO sample (value) VALUES (?)", [value]);
  db.close();
}

describe("legacy database migration", () => {
  test("copies, verifies, and records legacy databases while retaining the source", () => {
    const paths = locations("apply");
    createDatabase(join(paths.legacyDir, "harness.db"), "session-history");
    createDatabase(join(paths.legacyDir, "activity.db"), "audit-log");
    const plan = planStorageMigration(paths);
    expect(plan.migrationCount).toBe(2);
    expect(plan.conflicts).toBe(0);
    expect(plan.canApply).toBe(true);

    const result = applyStorageMigration({ expectedPlanId: plan.planId, locations: paths });
    expect(result.record?.databases).toHaveLength(2);
    expect(existsSync(join(paths.legacyDir, "harness.db"))).toBe(true);
    expect(existsSync(join(paths.dataDir, "harness.db"))).toBe(true);
    const migrated = new Database(join(paths.dataDir, "harness.db"), { readonly: true });
    expect(migrated.query("SELECT value FROM sample").get()).toEqual({ value: "session-history" });
    migrated.close();
    expect(result.plan.items.find((item) => item.name === "harness.db")?.status).toBe("migrated-backup-retained");
  });

  test("refuses a stale plan before writing a destination", () => {
    const paths = locations("stale");
    createDatabase(join(paths.legacyDir, "harness.db"), "safe");
    expect(() => applyStorageMigration({ expectedPlanId: "stale-plan", locations: paths })).toThrow("plan changed");
    expect(existsSync(join(paths.dataDir, "harness.db"))).toBe(false);
  });

  test("refuses to merge independently existing legacy and user databases", () => {
    const paths = locations("conflict");
    createDatabase(join(paths.legacyDir, "harness.db"), "legacy");
    createDatabase(join(paths.dataDir, "harness.db"), "current");
    const plan = planStorageMigration(paths);
    expect(plan.conflicts).toBe(1);
    expect(plan.canApply).toBe(false);
    expect(() => applyStorageMigration({ expectedPlanId: plan.planId, locations: paths })).toThrow("refused");
  });

  test("rolls back prepared destinations when any source is not a valid database", () => {
    const paths = locations("rollback");
    createDatabase(join(paths.legacyDir, "harness.db"), "valid");
    mkdirSync(paths.legacyDir, { recursive: true });
    writeFileSync(join(paths.legacyDir, "activity.db"), "not sqlite", "utf-8");
    const plan = planStorageMigration(paths);
    expect(() => applyStorageMigration({ expectedPlanId: plan.planId, locations: paths })).toThrow();
    expect(existsSync(join(paths.dataDir, "harness.db"))).toBe(false);
    expect(existsSync(join(paths.dataDir, "activity.db"))).toBe(false);
  });
});
