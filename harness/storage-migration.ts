import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { APP_PATHS, type AppPaths } from "./app-paths";

export const STORAGE_DATABASE_FILES = ["harness.db", "activity.db", "terminal.db"] as const;
export type StorageDatabaseFile = typeof STORAGE_DATABASE_FILES[number];
export type StorageMigrationStatus = "new" | "migrate" | "current" | "migrated-backup-retained" | "conflict";

export type StorageMigrationLocations = {
  legacyDir: string;
  dataDir: string;
  recordPath: string;
};

export type StorageMigrationItem = {
  name: StorageDatabaseFile;
  source: string;
  destination: string;
  status: StorageMigrationStatus;
  sourceBytes: number | null;
  sourceWalBytes: number;
  destinationBytes: number | null;
};

export type StorageMigrationPlan = {
  version: 1;
  planId: string;
  generatedAt: string;
  locations: StorageMigrationLocations;
  items: StorageMigrationItem[];
  canApply: boolean;
  migrationCount: number;
  conflicts: number;
  requiredBytes: number;
  availableBytes: number | null;
  hasCapacity: boolean;
};

export type StorageMigrationRecord = {
  version: 1;
  completedAt: string;
  databases: Array<{
    name: StorageDatabaseFile;
    source: string;
    destination: string;
    sourceBytes: number;
    destinationBytes: number;
    integrity: "ok";
  }>;
};

export function defaultStorageMigrationLocations(
  paths: Pick<AppPaths, "instance" | "resourcesDir" | "dataDir"> = APP_PATHS,
): StorageMigrationLocations {
  if (paths.instance) {
    throw new Error("Legacy storage migration is Main-only and cannot run inside a named Vault");
  }
  return {
    legacyDir: paths.resourcesDir,
    dataDir: paths.dataDir,
    recordPath: join(paths.dataDir, "migrations", "storage-v1.json"),
  };
}

function normalizedLocations(locations: StorageMigrationLocations): StorageMigrationLocations {
  return {
    legacyDir: resolve(locations.legacyDir),
    dataDir: resolve(locations.dataDir),
    recordPath: resolve(locations.recordPath),
  };
}

function readMigrationRecord(recordPath: string): StorageMigrationRecord | null {
  try {
    const value = JSON.parse(readFileSync(recordPath, "utf-8")) as StorageMigrationRecord;
    if (value.version !== 1 || !Array.isArray(value.databases)) return null;
    return value;
  } catch {
    return null;
  }
}

function fileBytes(path: string): number | null {
  try { return statSync(path).size; } catch { return null; }
}

function fileFingerprint(path: string): { bytes: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path);
    return { bytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch {
    return null;
  }
}

function nearestExistingDirectory(path: string): string | null {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function availableBytes(path: string): number | null {
  try {
    const existing = nearestExistingDirectory(path);
    if (!existing) return null;
    const stats = statfsSync(existing);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

export function planStorageMigration(
  inputLocations: StorageMigrationLocations = defaultStorageMigrationLocations(),
): StorageMigrationPlan {
  const locations = normalizedLocations(inputLocations);
  const record = readMigrationRecord(locations.recordPath);
  const items = STORAGE_DATABASE_FILES.map((name): StorageMigrationItem => {
    const source = join(locations.legacyDir, name);
    const destination = join(locations.dataDir, name);
    const sourceExists = existsSync(source);
    const destinationExists = existsSync(destination);
    const recorded = record?.databases.some((entry) => (
      entry.name === name
      && resolve(entry.source) === source
      && resolve(entry.destination) === destination
      && entry.integrity === "ok"
    )) ?? false;
    let status: StorageMigrationStatus;
    if (!sourceExists && !destinationExists) status = "new";
    else if (sourceExists && !destinationExists) status = "migrate";
    else if (!sourceExists && destinationExists) status = "current";
    else status = recorded ? "migrated-backup-retained" : "conflict";
    return {
      name,
      source,
      destination,
      status,
      sourceBytes: fileBytes(source),
      sourceWalBytes: fileBytes(`${source}-wal`) ?? 0,
      destinationBytes: fileBytes(destination),
    };
  });
  const migrationCount = items.filter((item) => item.status === "migrate").length;
  const conflicts = items.filter((item) => item.status === "conflict").length;
  const requiredBytes = items
    .filter((item) => item.status === "migrate")
    .reduce((total, item) => total + (item.sourceBytes ?? 0) + item.sourceWalBytes, 0);
  const freeBytes = availableBytes(locations.dataDir);
  const hasCapacity = freeBytes == null || freeBytes >= requiredBytes;
  const material = {
    version: 1,
    locations,
    files: items.map((item) => ({
      name: item.name,
      source: fileFingerprint(item.source),
      sourceWal: fileFingerprint(`${item.source}-wal`),
      destination: fileFingerprint(item.destination),
      status: item.status,
    })),
  };
  const planId = createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
  return {
    version: 1,
    planId,
    generatedAt: new Date().toISOString(),
    locations,
    items,
    canApply: migrationCount > 0 && conflicts === 0 && hasCapacity,
    migrationCount,
    conflicts,
    requiredBytes,
    availableBytes: freeBytes,
    hasCapacity,
  };
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Copies a legacy database through SQLite's own snapshot mechanism.
 *
 * VACUUM INTO runs inside a read transaction, so the destination is transactionally
 * consistent and already contains write-ahead log content that was never checkpointed —
 * including the case that matters most here, a previous run that exited without a clean
 * shutdown. It replaces a checkpoint-then-copyFileSync sequence that released its
 * exclusive lock before both the checkpoint and the copy, leaving a window for a
 * concurrent writer to change the file mid-copy.
 *
 * The connection must be read-only. VACUUM INTO never writes the source, but closing a
 * read-write handle checkpoints the WAL and truncates it, which would rewrite the very
 * database the migration retains as the user's rollback copy.
 */
function snapshotDatabase(source: string, destination: string): void {
  const db = new Database(source, { readonly: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.exec(`VACUUM INTO ${sqlStringLiteral(destination)}`);
  } finally {
    db.close();
  }
}

function integrityCheck(path: string): void {
  const db = new Database(path);
  try {
    const rows = db.query("PRAGMA integrity_check").values() as unknown[][];
    if (rows.length !== 1 || rows[0]?.[0] !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}: ${JSON.stringify(rows)}`);
    }
  } finally {
    db.close();
  }
}

export function applyStorageMigration(options: {
  expectedPlanId: string;
  locations?: StorageMigrationLocations;
  onProgress?: (message: string) => void;
}): { plan: StorageMigrationPlan; record: StorageMigrationRecord | null } {
  const plan = planStorageMigration(options.locations);
  if (plan.planId !== options.expectedPlanId) {
    throw new Error(`Storage migration plan changed: expected ${options.expectedPlanId}, got ${plan.planId}`);
  }
  if (plan.conflicts > 0) {
    throw new Error("Storage migration refused: legacy and destination databases both exist without a verified migration record");
  }
  if (!plan.hasCapacity) {
    throw new Error(`Storage migration requires ${plan.requiredBytes} bytes but only ${plan.availableBytes ?? 0} bytes are available`);
  }
  const migrating = plan.items.filter((item) => item.status === "migrate");
  if (migrating.length === 0) return { plan, record: readMigrationRecord(plan.locations.recordPath) };

  mkdirSync(plan.locations.dataDir, { recursive: true });
  mkdirSync(dirname(plan.locations.recordPath), { recursive: true });
  const prepared: Array<{ item: StorageMigrationItem; temp: string }> = [];
  const installed: string[] = [];
  const recordTemp = `${plan.locations.recordPath}.${randomUUID()}.tmp`;
  const previousRecord = readMigrationRecord(plan.locations.recordPath);
  try {
    for (const item of migrating) {
      const temp = join(plan.locations.dataDir, `.${item.name}.${randomUUID()}.migration`);
      options.onProgress?.(`Snapshotting ${item.name} into the user data directory...`);
      snapshotDatabase(item.source, temp);
      options.onProgress?.(`Verifying ${item.name} integrity...`);
      integrityCheck(temp);
      prepared.push({ item, temp });
    }
    for (const entry of prepared) {
      if (existsSync(entry.item.destination)) {
        throw new Error(`Storage migration destination appeared during apply: ${entry.item.destination}`);
      }
      renameSync(entry.temp, entry.item.destination);
      installed.push(entry.item.destination);
      options.onProgress?.(`Installed verified ${entry.item.name}.`);
    }
    const migratedNames = new Set(migrating.map((item) => item.name));
    const record: StorageMigrationRecord = {
      version: 1,
      completedAt: new Date().toISOString(),
      databases: [
        ...(previousRecord?.databases.filter((entry) => !migratedNames.has(entry.name)) ?? []),
        ...migrating.map((item) => ({
          name: item.name,
          source: item.source,
          destination: item.destination,
          sourceBytes: statSync(item.source).size,
          destinationBytes: statSync(item.destination).size,
          integrity: "ok" as const,
        })),
      ],
    };
    writeFileSync(recordTemp, JSON.stringify(record, null, 2) + "\n", "utf-8");
    renameSync(recordTemp, plan.locations.recordPath);
    options.onProgress?.("Recorded storage migration provenance.");
    return { plan: planStorageMigration(plan.locations), record };
  } catch (error) {
    for (const entry of prepared) rmSync(entry.temp, { force: true });
    for (const destination of installed) rmSync(destination, { force: true });
    rmSync(recordTemp, { force: true });
    throw error;
  }
}
