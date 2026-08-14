import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyStorageMigration,
  planStorageMigration,
  type StorageMigrationLocations,
} from "../storage-migration";

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

/**
 * Creates a WAL database and hands back the still-open handle, so the write-ahead
 * log survives instead of being checkpointed away by close().
 */
function openDatabaseWithLiveWal(path: string, rows: number): Database {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE sample (value TEXT NOT NULL)");
  for (let i = 0; i < rows; i++) db.run("INSERT INTO sample (value) VALUES (?)", [`row-${i}`]);
  return db;
}

function sizes(path: string): { db: number; wal: number } {
  return { db: statSync(path).size, wal: existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0 };
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

  test("leaves the retained legacy database byte-for-byte untouched", () => {
    const paths = locations("readonly-source");
    const source = join(paths.legacyDir, "harness.db");
    const live = openDatabaseWithLiveWal(source, 200);
    try {
      const before = sizes(source);
      expect(before.wal).toBeGreaterThan(0);

      const plan = planStorageMigration(paths);
      applyStorageMigration({ expectedPlanId: plan.planId, locations: paths });

      // The source is kept as the user's rollback copy. Checkpointing or truncating it
      // rewrites the very backup the migration promises to preserve.
      expect(sizes(source)).toEqual(before);
    } finally {
      live.close();
    }
  });

  test("migrates rows that exist only in the write-ahead log", () => {
    const paths = locations("wal-only");
    const source = join(paths.legacyDir, "harness.db");
    const live = openDatabaseWithLiveWal(source, 200);
    try {
      const plan = planStorageMigration(paths);
      applyStorageMigration({ expectedPlanId: plan.planId, locations: paths });

      const migrated = new Database(join(paths.dataDir, "harness.db"), { readonly: true });
      expect(migrated.query("SELECT COUNT(*) AS c FROM sample").get()).toEqual({ c: 200 });
      migrated.close();
    } finally {
      live.close();
    }
  });

  test("migrates while another connection holds the legacy database open", () => {
    const paths = locations("concurrent-reader");
    const source = join(paths.legacyDir, "harness.db");
    const live = openDatabaseWithLiveWal(source, 50);
    try {
      // A second Modus instance may hold this database open at startup. A TRUNCATE
      // checkpoint reports busy in that case; a snapshot does not need one.
      const plan = planStorageMigration(paths);
      expect(() => applyStorageMigration({ expectedPlanId: plan.planId, locations: paths })).not.toThrow();
      expect(existsSync(join(paths.dataDir, "harness.db"))).toBe(true);
    } finally {
      live.close();
    }
  });
});
