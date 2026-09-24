import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  applyStorageMigration,
  defaultStorageMigrationLocations,
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

function bytes(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function interruptedMigration(paths: StorageMigrationLocations, planId: string, installs: number): void {
  const root = join(paths.dataDir, "..", "..");
  const script = `
    import { applyStorageMigration } from "./storage-migration.ts";
    const locations = JSON.parse(process.env.MIGRATION_LOCATIONS!);
    let installed = 0;
    applyStorageMigration({ expectedPlanId: process.env.MIGRATION_PLAN_ID!, locations,
      onProgress(message) {
        if (message.startsWith("Installed verified") && ++installed === ${installs}) process.exit(73);
      },
    });
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: process.cwd(),
    env: {
      ...process.env,
      MIGRATION_LOCATIONS: JSON.stringify(paths),
      MIGRATION_PLAN_ID: planId,
      MODUS_HOME: root,
      MODUS_DATA_DIR: paths.dataDir,
      HARNESS_SECRETS_FILE: join(root, "secrets.env"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      TMP: join(root, "tmp"),
      TEMP: join(root, "tmp"),
      TMPDIR: join(root, "tmp"),
    },
  });
  expect(child.exitCode).toBe(73);
}

describe("legacy database migration", () => {
  test("default planning is Main-only", () => {
    expect(() => defaultStorageMigrationLocations({
      instance: "private",
      resourcesDir: "D:/resources",
      dataDir: "D:/vault/data",
    })).toThrow("Main-only");
  });

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

  for (const installs of [1, 3]) {
    test(`recovers safely after process exit following ${installs} installed database(s)`, () => {
      const paths = locations(`interrupted-${installs}`);
      const names = ["harness.db", "activity.db", "terminal.db"] as const;
      const writers = names.map((name) => openDatabaseWithLiveWal(join(paths.legacyDir, name), 10));
      try {
        const original = names.map((name) => {
          const source = join(paths.legacyDir, name);
          return { db: bytes(source), wal: bytes(`${source}-wal`) };
        });
        const firstPlan = planStorageMigration(paths);
        interruptedMigration(paths, firstPlan.planId, installs);
        expect(existsSync(`${paths.recordPath}.pending`)).toBe(true);
        expect(existsSync(paths.recordPath)).toBe(false);
        expect(names.filter((name) => existsSync(join(paths.dataDir, name)))).toHaveLength(installs);

        const recoveryPlan = planStorageMigration(paths);
        expect(recoveryPlan.conflicts).toBe(0);
        expect(recoveryPlan.migrationCount).toBe(3);
        const result = applyStorageMigration({ expectedPlanId: recoveryPlan.planId, locations: paths });
        expect(result.record?.databases).toHaveLength(3);
        expect(existsSync(`${paths.recordPath}.pending`)).toBe(false);
        for (const [index, name] of names.entries()) {
          const source = join(paths.legacyDir, name);
          expect({ db: bytes(source), wal: bytes(`${source}-wal`) }).toEqual(original[index]);
          const destination = new Database(join(paths.dataDir, name), { readonly: true });
          try {
            expect(destination.query("SELECT COUNT(*) AS c FROM sample").get()).toEqual({ c: 10 });
            expect(destination.query("SELECT value FROM sample ORDER BY rowid LIMIT 1").get()).toEqual({ value: "row-0" });
          } finally {
            destination.close();
          }
          expect(result.plan.items[index]?.status).toBe("migrated-backup-retained");
        }
      } finally {
        writers.forEach((writer) => writer.close());
      }
    }, 30_000);
  }

  test("refuses to remove an independent destination after interruption", () => {
    const paths = locations("interrupted-conflict");
    createDatabase(join(paths.legacyDir, "harness.db"), "legacy");
    createDatabase(join(paths.legacyDir, "activity.db"), "legacy-activity");
    const source = join(paths.legacyDir, "harness.db");
    const originalSource = bytes(source);
    const plan = planStorageMigration(paths);
    interruptedMigration(paths, plan.planId, 1);
    const destination = join(paths.dataDir, "harness.db");
    rmSync(destination);
    createDatabase(destination, "independent");
    const independent = bytes(destination);
    const recoveryPlan = planStorageMigration(paths);
    expect(recoveryPlan.conflicts).toBe(1);
    expect(() => applyStorageMigration({ expectedPlanId: recoveryPlan.planId, locations: paths })).toThrow("refused");
    expect(bytes(destination)).toBe(independent);
    expect(bytes(source)).toBe(originalSource);
    expect(existsSync(`${paths.recordPath}.pending`)).toBe(true);
  }, 30_000);

  test("a completed record is retained after exit before journal cleanup", () => {
    const paths = locations("committed-exit");
    createDatabase(join(paths.legacyDir, "harness.db"), "legacy");
    const plan = planStorageMigration(paths);
    const script = `
      import { applyStorageMigration } from "./storage-migration.ts";
      applyStorageMigration({ expectedPlanId: process.env.MIGRATION_PLAN_ID!,
        locations: JSON.parse(process.env.MIGRATION_LOCATIONS!),
        onProgress(message) {
          if (message === "Recorded storage migration provenance.") process.exit(74);
        },
      });
    `;
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", script], cwd: process.cwd(),
      env: { ...process.env, MIGRATION_LOCATIONS: JSON.stringify(paths), MIGRATION_PLAN_ID: plan.planId,
        MODUS_HOME: join(paths.dataDir, "..", ".."), HARNESS_SECRETS_FILE: join(paths.dataDir, "..", "..", "secrets.env"),
        XDG_CONFIG_HOME: join(paths.dataDir, "..", "..", "xdg-config"),
        XDG_DATA_HOME: join(paths.dataDir, "..", "..", "xdg-data"),
        XDG_CACHE_HOME: join(paths.dataDir, "..", "..", "xdg-cache") },
    });
    expect(child.exitCode).toBe(74);
    const destination = join(paths.dataDir, "harness.db");
    const installed = bytes(destination);
    expect(existsSync(`${paths.recordPath}.pending`)).toBe(true);
    const current = planStorageMigration(paths);
    expect(current.items[0]?.status).toBe("migrated-backup-retained");
    const result = applyStorageMigration({ expectedPlanId: current.planId, locations: paths });
    expect(result.record?.databases).toHaveLength(1);
    expect(bytes(destination)).toBe(installed);
    expect(existsSync(`${paths.recordPath}.pending`)).toBe(false);
  }, 30_000);

  test("caught install failure rolls back journaled destinations", () => {
    const paths = locations("caught-install");
    createDatabase(join(paths.legacyDir, "harness.db"), "legacy");
    createDatabase(join(paths.legacyDir, "activity.db"), "activity");
    const plan = planStorageMigration(paths);
    expect(() => applyStorageMigration({ expectedPlanId: plan.planId, locations: paths,
      onProgress(message) {
        if (message === "Installed verified harness.db.") throw new Error("injected failure");
      },
    })).toThrow("injected failure");
    expect(existsSync(`${paths.recordPath}.pending`)).toBe(false);
    expect(existsSync(join(paths.dataDir, "harness.db"))).toBe(false);
    expect(existsSync(join(paths.dataDir, "activity.db"))).toBe(false);
  });
});
