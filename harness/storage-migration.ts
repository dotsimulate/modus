import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  journalId?: string;
  databases: Array<{
    name: StorageDatabaseFile;
    source: string;
    destination: string;
    sourceBytes: number;
    destinationBytes: number;
    integrity: "ok";
  }>;
};

type PendingEntry = {
  name: StorageDatabaseFile;
  source: string;
  destination: string;
  temp: string;
  dev: string;
  ino: string;
  sha256: string;
};

type PendingMigration = {
  version: 1;
  id: string;
  locations: StorageMigrationLocations;
  entries: PendingEntry[];
};

function pendingPath(recordPath: string): string {
  return `${recordPath}.pending`;
}

function fileIdentity(path: string): { dev: string; ino: string } | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.ino === 0n) return null;
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } catch {
    return null;
  }
}

function fileDigest(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function matchesPendingFile(path: string, entry: PendingEntry): boolean {
  const identity = fileIdentity(path);
  return identity?.dev === entry.dev && identity.ino === entry.ino
    && fileDigest(path) === entry.sha256;
}

function readPendingMigration(locations: StorageMigrationLocations): PendingMigration | null {
  const path = pendingPath(locations.recordPath);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as PendingMigration;
    if (value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.entries)
      || JSON.stringify(value.locations) !== JSON.stringify(locations)
      || value.entries.length === 0 || value.entries.length > STORAGE_DATABASE_FILES.length) {
      throw new Error("invalid journal header");
    }
    const names = new Set<string>();
    for (const entry of value.entries) {
      if (!STORAGE_DATABASE_FILES.includes(entry.name) || names.has(entry.name)
        || entry.source !== join(locations.legacyDir, entry.name)
        || entry.destination !== join(locations.dataDir, entry.name)
        || dirname(entry.temp) !== locations.dataDir
        || !new RegExp(`^\\.${entry.name.replace(".", "\\.")}\\.[0-9a-f-]+\\.migration$`).test(entry.temp.split(/[\\/]/).at(-1) ?? "")
        || !/^\d+$/.test(entry.dev) || !/^[1-9]\d*$/.test(entry.ino)
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
        throw new Error("invalid journal entry");
      }
      names.add(entry.name);
    }
    return value;
  } catch {
    throw new Error(`Storage migration pending journal is invalid: ${path}`);
  }
}

function pendingEntryIsSafe(entry: PendingEntry): boolean {
  if (!existsSync(entry.source)
    || existsSync(`${entry.destination}-wal`) || existsSync(`${entry.destination}-shm`)) return false;
  const hasTemp = existsSync(entry.temp);
  const hasDestination = existsSync(entry.destination);
  return (!hasTemp || matchesPendingFile(entry.temp, entry))
    && (!hasDestination || matchesPendingFile(entry.destination, entry));
}

function rollbackPendingMigration(journal: PendingMigration): void {
  // Check every path before removing any file. An independently replaced or edited
  // destination must remain untouched, even if other entries still match.
  if (!journal.entries.every(pendingEntryIsSafe)) {
    throw new Error("Storage migration recovery refused: a pending file changed or disappeared");
  }
  for (const entry of journal.entries) {
    if (!pendingEntryIsSafe(entry)) {
      throw new Error("Storage migration recovery refused: a pending file changed during rollback");
    }
    rmSync(entry.destination, { force: true });
    rmSync(entry.temp, { force: true });
  }
  rmSync(pendingPath(journal.locations.recordPath), { force: true });
}

function writePendingMigration(journal: PendingMigration): void {
  const path = pendingPath(journal.locations.recordPath);
  const temp = `${path}.${journal.id}.tmp`;
  const fd = openSync(temp, "wx");
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n", "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // A hard link publishes the complete journal without replacing an existing one.
    linkSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

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
  const journal = readPendingMigration(locations);
  const activeJournal = journal && record?.journalId !== journal.id ? journal : null;
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
    const pending = activeJournal?.entries.find((entry) => entry.name === name);
    let status: StorageMigrationStatus;
    // Journal-owned installs are rolled back and snapshotted again during apply.
    if (pending) status = pendingEntryIsSafe(pending) ? "migrate" : "conflict";
    else if (!sourceExists && !destinationExists) status = "new";
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
    pendingId: activeJournal?.id ?? null,
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
  const journal = readPendingMigration(plan.locations);
  const previousRecord = readMigrationRecord(plan.locations.recordPath);
  if (journal) {
    if (previousRecord?.journalId === journal.id) {
      rmSync(pendingPath(plan.locations.recordPath), { force: true });
    } else {
      rollbackPendingMigration(journal);
    }
  }
  const freshPlan = journal ? planStorageMigration(plan.locations) : plan;
  if (freshPlan.conflicts > 0) {
    throw new Error("Storage migration refused: a destination appeared during recovery");
  }
  if (!freshPlan.hasCapacity) {
    throw new Error(`Storage migration requires ${freshPlan.requiredBytes} bytes but only ${freshPlan.availableBytes ?? 0} bytes are available`);
  }
  const migrating = freshPlan.items.filter((item) => item.status === "migrate");
  if (migrating.length === 0) return { plan: freshPlan, record: previousRecord };

  mkdirSync(freshPlan.locations.dataDir, { recursive: true });
  mkdirSync(dirname(freshPlan.locations.recordPath), { recursive: true });
  const prepared: Array<{ item: StorageMigrationItem; temp: string }> = [];
  const recordTemp = `${freshPlan.locations.recordPath}.${randomUUID()}.tmp`;
  let pending: PendingMigration | null = null;
  let recordCommitted = false;
  try {
    for (const item of migrating) {
      const temp = join(freshPlan.locations.dataDir, `.${item.name}.${randomUUID()}.migration`);
      options.onProgress?.(`Snapshotting ${item.name} into the user data directory...`);
      snapshotDatabase(item.source, temp);
      options.onProgress?.(`Verifying ${item.name} integrity...`);
      integrityCheck(temp);
      prepared.push({ item, temp });
    }
    pending = {
      version: 1,
      id: randomUUID(),
      locations: freshPlan.locations,
      entries: prepared.map(({ item, temp }) => {
        const identity = fileIdentity(temp);
        if (!identity) throw new Error(`Storage migration cannot identify prepared file: ${temp}`);
        return { name: item.name, source: item.source, destination: item.destination,
          temp, ...identity, sha256: fileDigest(temp) };
      }),
    };
    writePendingMigration(pending);
    for (const entry of prepared) {
      if (existsSync(entry.item.destination)) {
        throw new Error(`Storage migration destination appeared during apply: ${entry.item.destination}`);
      }
      // Hard-link creation fails if another process created the destination.
      linkSync(entry.temp, entry.item.destination);
      rmSync(entry.temp);
      options.onProgress?.(`Installed verified ${entry.item.name}.`);
    }
    const migratedNames = new Set(migrating.map((item) => item.name));
    const record: StorageMigrationRecord = {
      version: 1,
      completedAt: new Date().toISOString(),
      journalId: pending.id,
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
    renameSync(recordTemp, freshPlan.locations.recordPath);
    recordCommitted = true;
    options.onProgress?.("Recorded storage migration provenance.");
    rmSync(pendingPath(freshPlan.locations.recordPath), { force: true });
    return { plan: planStorageMigration(freshPlan.locations), record };
  } catch (error) {
    if (!recordCommitted) {
      if (pending && readPendingMigration(freshPlan.locations)?.id === pending.id) {
        rollbackPendingMigration(pending);
      } else {
        for (const entry of prepared) rmSync(entry.temp, { force: true });
      }
    }
    rmSync(recordTemp, { force: true });
    throw error;
  }
}
