import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "fs";
import { basename, join } from "path";
import type { Database } from "bun:sqlite";
import { homeCheckpointsDir } from "./modus-home";
import type { CheckpointRow } from "./db";

export const DEFAULT_CHECKPOINT_REPO_BYTES = 2 * 1024 * 1024 * 1024;
export const DEFAULT_CHECKPOINT_RETENTION_DAYS = 30;
export const DEFAULT_CHECKPOINT_RETAINED_COUNT = 200;

export type CheckpointMaintenancePolicy = {
  maxRepositoryBytes: number;
  retentionDays: number;
  maxRetainedCheckpoints: number;
};

export type CheckpointRepoPlan = {
  repo: string;
  cwd: string | null;
  currentBytes: number;
  rowCount: number;
  manifestRowCount: number;
  keepIds: number[];
  pruneIds: number[];
  protectedIds: number[];
  estimatedRetainedManifestBytes: number;
  reasons: string[];
  requiresRewrite: boolean;
};

export type CheckpointMaintenancePlan = {
  dryRun: true;
  planId: string;
  generatedAt: string;
  policy: CheckpointMaintenancePolicy;
  totals: {
    repositories: number;
    currentBytes: number;
    rows: number;
    keepRows: number;
    pruneRows: number;
    estimatedRetainedManifestBytes: number;
  };
  repositories: CheckpointRepoPlan[];
  warnings: string[];
};

export type CheckpointMaintenanceResult = {
  applied: true;
  planId: string;
  prunedRows: number;
  retainedRows: number;
  removedRepositories: string[];
  rewrittenRepositories: string[];
  bytesBefore: number;
  bytesAfter: number;
  warnings: string[];
};

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function checkpointMaintenancePolicy(): CheckpointMaintenancePolicy {
  return {
    maxRepositoryBytes: positiveEnvInt("MODUS_CHECKPOINT_MAX_REPOSITORY_BYTES", DEFAULT_CHECKPOINT_REPO_BYTES),
    retentionDays: positiveEnvInt("MODUS_CHECKPOINT_RETENTION_DAYS", DEFAULT_CHECKPOINT_RETENTION_DAYS),
    maxRetainedCheckpoints: positiveEnvInt("MODUS_CHECKPOINT_RETAINED_COUNT", DEFAULT_CHECKPOINT_RETAINED_COUNT),
  };
}

function manifestBytes(row: CheckpointRow): number | null {
  if (!row.manifest_json) return null;
  try {
    const parsed = JSON.parse(row.manifest_json);
    return parsed?.version === 2 && Number.isFinite(parsed?.totalBytes) ? Math.max(0, Number(parsed.totalBytes)) : null;
  } catch {
    return null;
  }
}

export function checkpointRepositoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let bytes = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(child);
        else if (entry.isFile() || entry.isSymbolicLink()) bytes += lstatSync(child).size;
      } catch { /* report best effort */ }
    }
  }
  return bytes;
}

function normalizedRoot(value: string): string {
  let path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") path = path.toLowerCase();
  return path;
}

function repoNameForCwd(cwd: string): string {
  return createHash("sha256").update(normalizedRoot(cwd)).digest("hex").slice(0, 16);
}

export function selectCheckpointRows(
  rows: CheckpointRow[],
  policy: CheckpointMaintenancePolicy,
  now: number,
  protectedSessionIds = new Set<string>(),
  protectedCheckpointIds = new Set<number>(),
): { keep: CheckpointRow[]; prune: CheckpointRow[]; protectedIds: number[]; estimatedBytes: number; reasons: string[] } {
  const cutoff = now - policy.retentionDays * 86_400_000;
  const sorted = [...rows].sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const required = new Set<number>(protectedCheckpointIds);
  for (const sessionId of protectedSessionIds) {
    const newest = sorted.find((row) => row.session_id === sessionId && manifestBytes(row) != null);
    if (newest) required.add(newest.id);
  }

  const keep: CheckpointRow[] = [];
  let estimatedBytes = 0;
  for (const row of sorted) {
    const bytes = manifestBytes(row);
    if (bytes == null) continue; // legacy/unmanaged rows cannot be restored safely
    const isRequired = required.has(row.id);
    const withinAge = row.created_at >= cutoff;
    const withinCount = keep.length < policy.maxRetainedCheckpoints;
    const withinBudget = estimatedBytes + bytes <= policy.maxRepositoryBytes;
    if (isRequired || (withinAge && withinCount && withinBudget)) {
      keep.push(row);
      estimatedBytes += bytes;
    }
  }
  const keepIds = new Set(keep.map((row) => row.id));
  const prune = sorted.filter((row) => !keepIds.has(row.id));
  const reasons: string[] = [];
  if (rows.some((row) => manifestBytes(row) == null)) reasons.push("legacy rows without a v2 managed manifest are non-restorable and selected for pruning");
  if (rows.some((row) => row.created_at < cutoff)) reasons.push(`rows older than ${policy.retentionDays} days are selected for pruning unless protected`);
  if (rows.length > policy.maxRetainedCheckpoints) reasons.push(`retained history is capped at ${policy.maxRetainedCheckpoints} checkpoints per repository`);
  if (estimatedBytes >= policy.maxRepositoryBytes) reasons.push("retained manifest bytes reached the repository budget");
  return { keep, prune, protectedIds: [...required], estimatedBytes, reasons };
}

export function planCheckpointMaintenance(options: {
  rows: CheckpointRow[];
  now?: number;
  policy?: CheckpointMaintenancePolicy;
  protectedSessionIds?: Set<string>;
  protectedCheckpointIds?: Set<number>;
  checkpointsDir?: string;
}): CheckpointMaintenancePlan {
  const now = options.now ?? Date.now();
  const policy = options.policy ?? checkpointMaintenancePolicy();
  const root = options.checkpointsDir ?? homeCheckpointsDir();
  const byRepo = new Map<string, CheckpointRow[]>();
  for (const row of options.rows) {
    const name = repoNameForCwd(row.cwd);
    const list = byRepo.get(name) ?? [];
    list.push(row);
    byRepo.set(name, list);
  }
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && !byRepo.has(entry.name)) byRepo.set(entry.name, []);
    }
  }

  const repositories: CheckpointRepoPlan[] = [];
  for (const [repo, rows] of byRepo) {
    const path = join(root, repo);
    const selected = selectCheckpointRows(
      rows, policy, now,
      options.protectedSessionIds,
      options.protectedCheckpointIds,
    );
    let cwd = rows[0]?.cwd ?? null;
    if (!cwd) {
      try { cwd = readFileSync(join(path, "work-tree.txt"), "utf-8").trim() || null; } catch {}
    }
    const currentBytes = checkpointRepositoryBytes(path);
    const reasons = [...selected.reasons];
    if (rows.length === 0) reasons.push("repository has no checkpoint database rows and is orphaned");
    if (currentBytes > policy.maxRepositoryBytes) reasons.push("repository exceeds the 2 GiB on-disk cap and requires history rewrite plus git gc");
    repositories.push({
      repo,
      cwd,
      currentBytes,
      rowCount: rows.length,
      manifestRowCount: rows.filter((row) => manifestBytes(row) != null).length,
      keepIds: selected.keep.map((row) => row.id),
      pruneIds: selected.prune.map((row) => row.id),
      protectedIds: selected.protectedIds,
      estimatedRetainedManifestBytes: selected.estimatedBytes,
      reasons,
      requiresRewrite: selected.prune.length > 0 || rows.length === 0 || currentBytes > policy.maxRepositoryBytes,
    });
  }
  repositories.sort((a, b) => b.currentBytes - a.currentBytes);
  const totals = repositories.reduce((acc, repo) => ({
    repositories: acc.repositories + 1,
    currentBytes: acc.currentBytes + repo.currentBytes,
    rows: acc.rows + repo.rowCount,
    keepRows: acc.keepRows + repo.keepIds.length,
    pruneRows: acc.pruneRows + repo.pruneIds.length,
    estimatedRetainedManifestBytes: acc.estimatedRetainedManifestBytes + repo.estimatedRetainedManifestBytes,
  }), { repositories: 0, currentBytes: 0, rows: 0, keepRows: 0, pruneRows: 0, estimatedRetainedManifestBytes: 0 });
  const stable = JSON.stringify({ policy, repositories: repositories.map((repo) => ({ repo: repo.repo, keep: repo.keepIds, prune: repo.pruneIds })) });
  return {
    dryRun: true,
    planId: createHash("sha256").update(stable).digest("hex").slice(0, 16),
    generatedAt: new Date(now).toISOString(),
    policy,
    totals,
    repositories,
    warnings: [
      "Dry run only: no checkpoint rows, refs, objects, or files were changed.",
      "On-disk savings require a confirmed history rewrite and git gc; manifest-byte estimates are conservative and not a promise of final pack size.",
      "A future apply operation must re-create this plan and match its planId before changing data.",
    ],
  };
}

function git(gitDir: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["--git-dir", gitDir, ...args], {
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...env },
  }).trim();
}

function readRef(gitDir: string, ref: string): string | null {
  try { return git(gitDir, ["rev-parse", "--verify", ref]); } catch { return null; }
}

type SwitchedRepository = {
  path: string;
  oldHead: string | null;
  newHead: string | null;
  temporaryRef: string;
  backupRef: string;
};

/**
 * Apply a previously reviewed plan while holding SQLite's write lock.
 *
 * Retained snapshots are rebuilt as a short, disconnected commit chain so
 * their trees remain byte-for-byte restorable without retaining pruned
 * ancestors. Git refs are prepared before database rows change, and the old
 * head remains protected until the database transaction commits.
 */
export function applyCheckpointMaintenance(options: {
  db: Database;
  expectedPlanId: string;
  checkpointsDir?: string;
  now?: number;
  policy?: CheckpointMaintenancePolicy;
}): CheckpointMaintenanceResult {
  const root = options.checkpointsDir ?? homeCheckpointsDir();
  const switched: SwitchedRepository[] = [];
  const rewrittenRepositories: string[] = [];
  const removedRepositories: string[] = [];
  const warnings: string[] = [];
  let plan: CheckpointMaintenancePlan | null = null;
  let committed = false;

  options.db.run("BEGIN IMMEDIATE");
  try {
    const rows = options.db.query("SELECT * FROM checkpoints ORDER BY cwd, created_at DESC, id DESC").all() as CheckpointRow[];
    const active = options.db.query(
      "SELECT id FROM sessions WHERE status IN ('running','starting','interrupting','idle','paused')",
    ).all() as Array<{ id: string }>;
    plan = planCheckpointMaintenance({
      rows,
      now: options.now,
      policy: options.policy,
      checkpointsDir: root,
      protectedSessionIds: new Set(active.map((entry) => entry.id)),
    });
    if (plan.planId !== options.expectedPlanId) {
      throw new Error(`checkpoint plan changed: expected ${options.expectedPlanId}, got ${plan.planId}`);
    }

    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const rewrittenHashes = new Map<number, string>();

    for (const repo of plan.repositories) {
      if (!repo.requiresRewrite || repo.keepIds.length === 0) continue;
      const path = join(root, repo.repo);
      if (!existsSync(path)) throw new Error(`checkpoint repository disappeared: ${path}`);
      const temporaryRef = `refs/modus-maintenance/${plan.planId}/new`;
      const backupRef = `refs/modus-maintenance/${plan.planId}/backup`;
      const oldHead = readRef(path, "refs/heads/main");
      if (!oldHead) throw new Error(`checkpoint repository has no main ref: ${path}`);
      git(path, ["update-ref", backupRef, oldHead]);

      const retained = repo.keepIds
        .map((id) => rowsById.get(id))
        .filter((row): row is CheckpointRow => Boolean(row))
        .sort((a, b) => a.created_at - b.created_at || a.id - b.id);
      if (retained.length !== repo.keepIds.length) throw new Error(`retained checkpoint row disappeared for ${repo.repo}`);

      let parent: string | null = null;
      for (const row of retained) {
        const tree = git(path, ["rev-parse", `${row.commit_hash}^{tree}`]);
        const args = ["commit-tree", tree];
        if (parent) args.push("-p", parent);
        args.push("-m", `modus retained checkpoint id=${row.id} plan=${plan.planId}`);
        const timestamp = new Date(row.created_at).toISOString();
        const rewritten = git(path, args, {
          GIT_AUTHOR_NAME: "modus-checkpoint",
          GIT_AUTHOR_EMAIL: "checkpoint@modus.local",
          GIT_AUTHOR_DATE: timestamp,
          GIT_COMMITTER_NAME: "modus-checkpoint",
          GIT_COMMITTER_EMAIL: "checkpoint@modus.local",
          GIT_COMMITTER_DATE: timestamp,
        });
        const rewrittenTree = git(path, ["rev-parse", `${rewritten}^{tree}`]);
        if (rewrittenTree !== tree) throw new Error(`tree verification failed for checkpoint ${row.id}`);
        rewrittenHashes.set(row.id, rewritten);
        parent = rewritten;
      }
      git(path, ["update-ref", temporaryRef, parent!]);
      git(path, ["update-ref", "refs/heads/main", parent!, oldHead]);
      switched.push({ path, oldHead, newHead: parent, temporaryRef, backupRef });
      rewrittenRepositories.push(repo.repo);
    }

    const updateHash = options.db.prepare("UPDATE checkpoints SET commit_hash = ? WHERE id = ? AND commit_hash = ?");
    for (const [id, hash] of rewrittenHashes) {
      const original = rowsById.get(id)!;
      const result = updateHash.run(hash, id, original.commit_hash);
      if (result.changes !== 1) throw new Error(`checkpoint ${id} changed during maintenance`);
    }
    const deleteRow = options.db.prepare("DELETE FROM checkpoints WHERE id = ?");
    for (const repo of plan.repositories) {
      for (const id of repo.pruneIds) {
        const result = deleteRow.run(id);
        if (result.changes !== 1) throw new Error(`checkpoint ${id} changed during maintenance`);
      }
    }
    options.db.run("COMMIT");
    committed = true;
  } catch (error) {
    if (!committed) {
      try { options.db.run("ROLLBACK"); } catch {}
      for (const repo of [...switched].reverse()) {
        try {
          const current = readRef(repo.path, "refs/heads/main");
          if (repo.oldHead && current === repo.newHead) git(repo.path, ["update-ref", "refs/heads/main", repo.oldHead, repo.newHead!]);
        } catch {}
        try { git(repo.path, ["update-ref", "-d", repo.temporaryRef]); } catch {}
        try { git(repo.path, ["update-ref", "-d", repo.backupRef]); } catch {}
      }
    }
    throw error;
  }

  // After the durable DB commit, old refs can be released. Use Git's default
  // two-week prune grace so concurrent checkpoint writes cannot lose a fresh
  // object. Unreachable older packs/objects are reclaimed immediately when
  // eligible; newer unreachable objects age out on a later maintenance run.
  for (const repo of switched) {
    try { git(repo.path, ["update-ref", "-d", repo.temporaryRef]); } catch (error: any) { warnings.push(String(error?.message ?? error)); }
    try { git(repo.path, ["update-ref", "-d", repo.backupRef]); } catch (error: any) { warnings.push(String(error?.message ?? error)); }
    try { git(repo.path, ["reflog", "expire", "--expire=now", "--all"]); } catch (error: any) { warnings.push(String(error?.message ?? error)); }
    try { git(repo.path, ["gc"]); } catch (error: any) { warnings.push(String(error?.message ?? error)); }
  }
  for (const repo of plan!.repositories) {
    if (repo.keepIds.length !== 0) continue;
    const path = join(root, repo.repo);
    if (!existsSync(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      removedRepositories.push(repo.repo);
    } catch (error: any) {
      warnings.push(`could not remove ${path}: ${error?.message ?? error}`);
    }
  }

  const bytesAfter = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .reduce((sum, entry) => sum + checkpointRepositoryBytes(join(root, entry.name)), 0)
    : 0;
  return {
    applied: true,
    planId: plan!.planId,
    prunedRows: plan!.totals.pruneRows,
    retainedRows: plan!.totals.keepRows,
    removedRepositories,
    rewrittenRepositories,
    bytesBefore: plan!.totals.currentBytes,
    bytesAfter,
    warnings,
  };
}
