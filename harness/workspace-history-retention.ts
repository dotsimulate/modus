import type { Database } from "bun:sqlite";

export type PinnedRef = {
  commitId: string;
  note?: string;
  createdAt: string;
};

export type CompactionPolicy = {
  retainLastN: number;
  retainPinnedAlways: boolean;
  retainDays: number;
};

const DEFAULT_POLICY: CompactionPolicy = {
  retainLastN: 100,
  retainPinnedAlways: true,
  retainDays: 90,
};

export function pin(db: Database, commitId: string, note?: string): void {
  const exists = db.prepare(`SELECT id FROM commits WHERE id = ?`).get(commitId);
  if (!exists) throw new Error(`commit ${commitId} not found`);

  db.run(
    `INSERT OR REPLACE INTO pins (commit_id, note, created_at) VALUES (?, ?, ?)`,
    [commitId, note ?? null, new Date().toISOString()],
  );
}

export function unpin(db: Database, commitId: string): boolean {
  const result = db.run(`DELETE FROM pins WHERE commit_id = ?`, [commitId]);
  return result.changes > 0;
}

export function listPins(db: Database): PinnedRef[] {
  const rows = db.prepare(
    `SELECT commit_id, note, created_at FROM pins ORDER BY created_at DESC`,
  ).all() as Array<{ commit_id: string; note: string | null; created_at: string }>;

  return rows.map((r) => ({
    commitId: r.commit_id,
    note: r.note ?? undefined,
    createdAt: r.created_at,
  }));
}

export function isPinned(db: Database, commitId: string): boolean {
  const row = db.prepare(`SELECT commit_id FROM pins WHERE commit_id = ?`).get(commitId);
  return row !== null;
}

export function getCompactionPolicy(): CompactionPolicy {
  return { ...DEFAULT_POLICY };
}

export function compactionCandidates(
  db: Database,
  policy: CompactionPolicy = DEFAULT_POLICY,
): string[] {
  const cutoffDate = new Date(Date.now() - policy.retainDays * 86_400_000).toISOString();

  const rows = db.prepare(
    `SELECT c.id FROM commits c
     WHERE c.ts < ?
     ORDER BY c.ts ASC`,
  ).all(cutoffDate) as Array<{ id: string }>;

  const candidates: string[] = [];
  for (const row of rows) {
    if (policy.retainPinnedAlways && isPinned(db, row.id)) continue;
    candidates.push(row.id);
  }

  const recentCount = db.prepare(`SELECT COUNT(*) as cnt FROM commits WHERE ts >= ?`).get(cutoffDate) as { cnt: number };
  if (recentCount.cnt < policy.retainLastN) {
    const keepExtra = policy.retainLastN - recentCount.cnt;
    return candidates.slice(0, Math.max(0, candidates.length - keepExtra));
  }

  return candidates;
}
