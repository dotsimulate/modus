import { Database } from "bun:sqlite";
import { join } from "path";
import type { ShadowScope, CommitRecord, ActorInfo } from "./workspace-history";
import type { EntityRef, EntityKind } from "./workspace-entities";

export type EntityOp = "add" | "modify" | "delete";

export type ChangeFilters = {
  since?: string;
  until?: string;
  kind?: string;
  entity?: string;
  actor?: string;
  limit?: number;
};

export type ChangeRecord = {
  id: string;
  ts: string;
  summary: string;
  entities: EntityRef[];
  entityOps?: Record<string, EntityOp>;
  actor?: ActorInfo;
  isRestore?: boolean;
  restoreTarget?: string;
};

export type EntityStateRecord = {
  kind: EntityKind;
  id: string;
  lastCommitId: string;
  lastCommitTs?: string;
  contentHash?: string;
};

// ── DB lifecycle ──

const indexes = new Map<string, Database>();

function scopeKey(scope: ShadowScope): string {
  return scope.kind === "project" ? `project:${scope.projectId}` : "user";
}

export function indexPath(shadowRoot: string): string {
  return join(shadowRoot, "index.sqlite");
}

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commits (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      summary TEXT NOT NULL,
      actor_json TEXT,
      is_restore INTEGER DEFAULT 0,
      restore_target TEXT
    );

    CREATE TABLE IF NOT EXISTS entity_changes (
      commit_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      op TEXT NOT NULL,
      FOREIGN KEY (commit_id) REFERENCES commits(id)
    );

    CREATE INDEX IF NOT EXISTS idx_ec_commit ON entity_changes(commit_id);
    CREATE INDEX IF NOT EXISTS idx_ec_entity ON entity_changes(kind, entity_id);

    CREATE TABLE IF NOT EXISTS entity_state (
      kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      content_hash TEXT,
      PRIMARY KEY (kind, entity_id),
      FOREIGN KEY (commit_id) REFERENCES commits(id)
    );

    CREATE TABLE IF NOT EXISTS pins (
      commit_id TEXT PRIMARY KEY,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (commit_id) REFERENCES commits(id)
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function openIndex(scope: ShadowScope, shadowRoot: string): Database {
  const key = scopeKey(scope);
  const existing = indexes.get(key);
  if (existing) return existing;

  const dbPath = indexPath(shadowRoot);
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  createSchema(db);
  indexes.set(key, db);
  return db;
}

export function getIndex(scope: ShadowScope): Database | null {
  return indexes.get(scopeKey(scope)) ?? null;
}

export function closeIndex(scope: ShadowScope): void {
  const key = scopeKey(scope);
  const db = indexes.get(key);
  if (db) {
    db.close();
    indexes.delete(key);
  }
}

// ── Write operations ──

export function indexCommit(
  db: Database,
  record: CommitRecord,
  entityOps: Map<string, string>,
): void {
  const tx = db.transaction(() => {
    db.run(
      `INSERT OR REPLACE INTO commits (id, ts, summary, actor_json, is_restore, restore_target) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ts,
        record.summary,
        record.actor ? JSON.stringify(record.actor) : null,
        record.isRestore ? 1 : 0,
        null,
      ],
    );

    const insertChange = db.prepare(
      `INSERT INTO entity_changes (commit_id, kind, entity_id, op) VALUES (?, ?, ?, ?)`,
    );
    const upsertState = db.prepare(
      `INSERT OR REPLACE INTO entity_state (kind, entity_id, commit_id, content_hash) VALUES (?, ?, ?, ?)`,
    );

    for (const entity of record.entities) {
      const opKey = `${entity.kind}:${entity.id}`;
      const op = entityOps.get(opKey) ?? "modify";
      insertChange.run(record.id, entity.kind, entity.id, op);

      if (op === "delete") {
        db.run(`DELETE FROM entity_state WHERE kind = ? AND entity_id = ?`, [entity.kind, entity.id]);
      } else {
        upsertState.run(entity.kind, entity.id, record.id, null);
      }
    }

    db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('head', ?)`, [record.id]);
  });

  tx();
}

export function getStoredHead(db: Database): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'head'`).get() as { value: string } | null;
  return row?.value ?? null;
}

// ── Rebuild from parsed commit records ──

export type DiffTreeEntry = { op: string; path: string };

export function rebuildIndex(
  db: Database,
  records: CommitRecord[],
  diffTrees: Map<string, DiffTreeEntry[]>,
  workTree: string,
  entityResolver: (absPath: string, workTree: string) => EntityRef[],
): void {
  db.run("DELETE FROM commits");
  db.run("DELETE FROM entity_changes");
  db.run("DELETE FROM entity_state");
  db.run("DELETE FROM meta");

  const sorted = [...records].sort((a, b) => a.ts.localeCompare(b.ts));

  const insertCommit = db.prepare(
    `INSERT OR REPLACE INTO commits (id, ts, summary, actor_json, is_restore, restore_target) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChange = db.prepare(
    `INSERT INTO entity_changes (commit_id, kind, entity_id, op) VALUES (?, ?, ?, ?)`,
  );
  const upsertState = db.prepare(
    `INSERT OR REPLACE INTO entity_state (kind, entity_id, commit_id, content_hash) VALUES (?, ?, ?, ?)`,
  );
  const deleteState = db.prepare(
    `DELETE FROM entity_state WHERE kind = ? AND entity_id = ?`,
  );

  const tx = db.transaction(() => {
    for (const record of sorted) {
      insertCommit.run(
        record.id,
        record.ts,
        record.summary,
        record.actor ? JSON.stringify(record.actor) : null,
        record.isRestore ? 1 : 0,
        null,
      );

      const diffTree = diffTrees.get(record.id) ?? [];
      const entityOps = new Map<string, EntityOp>();

      for (const entry of diffTree) {
        const absPath = join(workTree, entry.path);
        const refs = entityResolver(absPath, workTree);
        const fileOp: EntityOp = entry.op === "A" ? "add" : entry.op === "D" ? "delete" : "modify";

        for (const ref of refs) {
          const key = `${ref.kind}:${ref.id}`;
          const existing = entityOps.get(key);
          if (!existing) {
            entityOps.set(key, fileOp);
          } else if (existing !== fileOp && existing !== "modify") {
            entityOps.set(key, "modify");
          }
        }
      }

      for (const entity of record.entities) {
        const opKey = `${entity.kind}:${entity.id}`;
        const op = entityOps.get(opKey) ?? "add";
        insertChange.run(record.id, entity.kind, entity.id, op);

        if (op === "delete") {
          deleteState.run(entity.kind, entity.id);
        } else {
          upsertState.run(entity.kind, entity.id, record.id, null);
        }
      }

      db.run(`INSERT OR REPLACE INTO meta (key, value) VALUES ('head', ?)`, [record.id]);
    }
  });

  tx();
}

// ── Read operations ──

export function queryChanges(db: Database, filters: ChangeFilters): ChangeRecord[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters.since) {
    conditions.push("c.ts >= ?");
    params.push(filters.since);
  }
  if (filters.until) {
    conditions.push("c.ts <= ?");
    params.push(filters.until);
  }
  if (filters.kind) {
    conditions.push("EXISTS (SELECT 1 FROM entity_changes ec WHERE ec.commit_id = c.id AND ec.kind = ?)");
    params.push(filters.kind);
  }
  if (filters.entity) {
    const parts = filters.entity.split(":");
    const ek = parts[0]!;
    const eid = parts.slice(1).join(":");
    conditions.push("EXISTS (SELECT 1 FROM entity_changes ec WHERE ec.commit_id = c.id AND ec.kind = ? AND ec.entity_id = ?)");
    params.push(ek, eid);
  }
  if (filters.actor) {
    conditions.push("json_extract(c.actor_json, '$.type') = ?");
    params.push(filters.actor);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;
  params.push(limit);

  const rows = db.prepare(
    `SELECT c.id, c.ts, c.summary, c.actor_json, c.is_restore, c.restore_target
     FROM commits c ${where}
     ORDER BY c.ts DESC LIMIT ?`,
  ).all(...params) as Array<{
    id: string; ts: string; summary: string; actor_json: string | null;
    is_restore: number; restore_target: string | null;
  }>;

  return rows.map((row) => hydrateChangeRecord(db, row));
}

export function getChange(db: Database, commitId: string): ChangeRecord | null {
  const row = db.prepare(
    `SELECT id, ts, summary, actor_json, is_restore, restore_target FROM commits WHERE id = ?`,
  ).get(commitId) as {
    id: string; ts: string; summary: string; actor_json: string | null;
    is_restore: number; restore_target: string | null;
  } | null;

  if (!row) return null;
  return hydrateChangeRecord(db, row);
}

export function getEntityRevisions(
  db: Database,
  kind: string,
  entityId: string,
  limit = 50,
): ChangeRecord[] {
  const rows = db.prepare(
    `SELECT DISTINCT c.id, c.ts, c.summary, c.actor_json, c.is_restore, c.restore_target
     FROM commits c
     JOIN entity_changes ec ON ec.commit_id = c.id
     WHERE ec.kind = ? AND ec.entity_id = ?
     ORDER BY c.ts DESC LIMIT ?`,
  ).all(kind, entityId, limit) as Array<{
    id: string; ts: string; summary: string; actor_json: string | null;
    is_restore: number; restore_target: string | null;
  }>;

  return rows.map((row) => hydrateChangeRecord(db, row));
}

export function listEntityStates(db: Database, at?: string): EntityStateRecord[] {
  if (!at) {
    const rows = db.prepare(
      `SELECT es.kind, es.entity_id, es.commit_id, es.content_hash, c.ts
       FROM entity_state es
       JOIN commits c ON c.id = es.commit_id
       ORDER BY es.kind, es.entity_id`,
    ).all() as Array<{ kind: string; entity_id: string; commit_id: string; content_hash: string | null; ts: string }>;

    return rows.map((r) => ({
      kind: r.kind as EntityKind,
      id: r.entity_id,
      lastCommitId: r.commit_id,
      lastCommitTs: r.ts,
      contentHash: r.content_hash ?? undefined,
    }));
  }

  const rows = db.prepare(
    `SELECT ec.kind, ec.entity_id, ec.commit_id, ec.op, c.ts
     FROM entity_changes ec
     JOIN commits c ON c.id = ec.commit_id
     WHERE c.ts <= ?
       AND ec.rowid = (
         SELECT ec2.rowid FROM entity_changes ec2
         JOIN commits c2 ON c2.id = ec2.commit_id
         WHERE ec2.kind = ec.kind AND ec2.entity_id = ec.entity_id AND c2.ts <= ?
         ORDER BY c2.ts DESC LIMIT 1
       )
       AND ec.op != 'delete'
     ORDER BY ec.kind, ec.entity_id`,
  ).all(at, at) as Array<{ kind: string; entity_id: string; commit_id: string; op: string; ts: string }>;

  return rows.map((r) => ({
    kind: r.kind as EntityKind,
    id: r.entity_id,
    lastCommitId: r.commit_id,
    lastCommitTs: r.ts,
  }));
}

export function getEntityState(
  db: Database,
  kind: string,
  entityId: string,
  at?: string,
): EntityStateRecord | null {
  if (!at) {
    const row = db.prepare(
      `SELECT es.kind, es.entity_id, es.commit_id, es.content_hash, c.ts
       FROM entity_state es
       JOIN commits c ON c.id = es.commit_id
       WHERE es.kind = ? AND es.entity_id = ?`,
    ).get(kind, entityId) as { kind: string; entity_id: string; commit_id: string; content_hash: string | null; ts: string } | null;

    if (!row) return null;
    return {
      kind: row.kind as EntityKind,
      id: row.entity_id,
      lastCommitId: row.commit_id,
      lastCommitTs: row.ts,
      contentHash: row.content_hash ?? undefined,
    };
  }

  const row = db.prepare(
    `SELECT ec.kind, ec.entity_id, ec.commit_id, ec.op, c.ts
     FROM entity_changes ec
     JOIN commits c ON c.id = ec.commit_id
     WHERE ec.kind = ? AND ec.entity_id = ? AND c.ts <= ?
     ORDER BY c.ts DESC LIMIT 1`,
  ).get(kind, entityId, at) as { kind: string; entity_id: string; commit_id: string; op: string; ts: string } | null;

  if (!row || row.op === "delete") return null;
  return {
    kind: row.kind as EntityKind,
    id: row.entity_id,
    lastCommitId: row.commit_id,
    lastCommitTs: row.ts,
  };
}

// ── Helpers ──

function hydrateChangeRecord(
  db: Database,
  row: { id: string; ts: string; summary: string; actor_json: string | null; is_restore: number; restore_target: string | null },
): ChangeRecord {
  const entityRows = db.prepare(
    `SELECT kind, entity_id, op FROM entity_changes WHERE commit_id = ?`,
  ).all(row.id) as Array<{ kind: string; entity_id: string; op: string }>;

  const entities: EntityRef[] = entityRows.map((e) => ({ kind: e.kind as EntityKind, id: e.entity_id }));
  const entityOps: Record<string, EntityOp> = {};
  for (const e of entityRows) {
    entityOps[`${e.kind}:${e.entity_id}`] = e.op as EntityOp;
  }

  return {
    id: row.id,
    ts: row.ts,
    summary: row.summary,
    entities,
    entityOps,
    actor: row.actor_json ? JSON.parse(row.actor_json) : undefined,
    isRestore: row.is_restore === 1 || undefined,
    restoreTarget: row.restore_target ?? undefined,
  };
}
