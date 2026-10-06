import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join, dirname, relative, sep } from "path";
import { randomUUID } from "crypto";
import {
  shadowRepoPath, gitShowFile, gitLsTree, commitIfChanged, getWorkTree,
  type ShadowScope, type ActorInfo, type CommitRecord,
} from "./workspace-history";
import { projectEntities, userEntities, type EntityRef, type EntityKind } from "./workspace-entities";
import { entityDiff, type EntityDiff } from "./workspace-history-diff";
import { isTracked } from "./workspace-history-filter";
import { getChange, getIndex, indexCommit } from "./workspace-history-index";
import type { Database } from "bun:sqlite";

// ── Types ──

export type RestoreTarget =
  | { type: "change"; changeId: string }
  | { type: "timestamp"; at: string };

export type EntitySelection = EntityRef[] | "all";

export type RestorePlanEntry = {
  ref: EntityRef;
  files: RestorePlanFile[];
  diff: EntityDiff;
  currentHash: string;
};

type RestorePlanFile = {
  relPath: string;
  targetContent: string | null;
  currentContent: string | null;
};

export type RestorePlan = {
  id: string;
  scope: ShadowScope;
  target: RestoreTarget;
  resolvedChangeId: string;
  entries: RestorePlanEntry[];
  createdAt: string;
  expiresAt: string;
};

export type RestoreResult = {
  ok: boolean;
  changeRecord?: CommitRecord;
  partial?: boolean;
  failed?: { ref: EntityRef; error: string }[];
};

type DriftError = {
  type: "DRIFT";
  entity: string;
  expected: string;
  actual: string;
};

// ── Plan storage ──

const PLAN_TTL_MS = 10 * 60 * 1000;

function pendingPlansDir(scope: ShadowScope): string {
  return join(shadowRepoPath(scope), "pending-plans");
}

function writePlan(plan: RestorePlan): void {
  const dir = pendingPlansDir(plan.scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${plan.id}.json`), JSON.stringify(plan));
}

function readPlan(scope: ShadowScope, planId: string): RestorePlan | null {
  const filePath = join(pendingPlansDir(scope), `${planId}.json`);
  if (!existsSync(filePath)) return null;
  const plan = JSON.parse(readFileSync(filePath, "utf-8")) as RestorePlan;
  if (new Date(plan.expiresAt).getTime() < Date.now()) {
    try { unlinkSync(filePath); } catch { /* best effort */ }
    return null;
  }
  return plan;
}

function removePlan(scope: ShadowScope, planId: string): void {
  const filePath = join(pendingPlansDir(scope), `${planId}.json`);
  try { unlinkSync(filePath); } catch { /* best effort */ }
}

// ── Content hashing ──

function contentHash(content: string | null): string {
  if (content === null) return "null";
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

// ── File helpers ──

function currentFileContent(workTree: string, relPath: string): string | null {
  const abs = join(workTree, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, "utf-8");
}

// ── Plan ──

export async function planRestore(
  scope: ShadowScope,
  db: Database,
  target: RestoreTarget,
  selection: EntitySelection,
): Promise<RestorePlan> {
  const resolvedChangeId = await resolveTarget(scope, db, target);
  if (!resolvedChangeId) throw new Error("target commit not found");

  const workTree = getWorkTree(scope);
  const targetFiles = await gitLsTree(scope, resolvedChangeId);
  const currentFiles = listCurrentFiles(workTree, scope);
  const allFiles = [...new Set([...targetFiles, ...currentFiles])];

  const resolver = scope.kind === "project" ? projectEntities : userEntities;

  const entityMap = new Map<string, { ref: EntityRef; files: Set<string> }>();
  for (const f of allFiles) {
    const refs = resolver(join(workTree, f), workTree);
    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      const entry = entityMap.get(key);
      if (entry) {
        entry.files.add(f);
      } else {
        entityMap.set(key, { ref, files: new Set([f]) });
      }
    }
  }

  const selected = selection === "all"
    ? [...entityMap.values()]
    : selection.map((sel) => {
        const key = `${sel.kind}:${sel.id}`;
        const entry = entityMap.get(key);
        if (!entry) return { ref: sel, files: new Set<string>() };
        return entry;
      });

  const entries: RestorePlanEntry[] = [];
  for (const { ref, files } of selected) {
    const fileList = [...files];
    const planFiles: RestorePlanFile[] = [];
    let fromContent: string | null = null;
    let toContent: string | null = null;

    for (const f of fileList) {
      const target = targetFiles.includes(f)
        ? await gitShowFile(scope, resolvedChangeId, f)
        : null;
      const current = currentFileContent(workTree, f);
      planFiles.push({ relPath: f, targetContent: target, currentContent: current });

      if (current !== null) {
        fromContent = fromContent !== null ? fromContent + "\n" + current : current;
      }
      if (target !== null) {
        toContent = toContent !== null ? toContent + "\n" + target : target;
      }
    }

    if (planFiles.every((pf) => pf.targetContent === pf.currentContent)) continue;

    const combinedHash = contentHash(planFiles.map((pf) => pf.currentContent ?? "").join("\0"));
    const diff = entityDiff(ref, fromContent, toContent);

    entries.push({ ref, files: planFiles, diff, currentHash: combinedHash });
  }

  const now = new Date();
  const plan: RestorePlan = {
    id: randomUUID(),
    scope,
    target,
    resolvedChangeId,
    entries,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PLAN_TTL_MS).toISOString(),
  };

  writePlan(plan);
  return plan;
}

// ── Apply ──

let commitsPaused = false;

export function isCommitsPaused(): boolean {
  return commitsPaused;
}

export async function applyRestore(
  scope: ShadowScope,
  planId: string,
  actor: ActorInfo,
): Promise<RestoreResult> {
  const plan = readPlan(scope, planId);
  if (!plan) throw new Error("plan not found or expired");

  const workTree = getWorkTree(scope);
  const driftErrors: DriftError[] = [];

  for (const entry of plan.entries) {
    const currentCombined = contentHash(
      entry.files.map((f) => currentFileContent(workTree, f.relPath) ?? "").join("\0"),
    );
    if (currentCombined !== entry.currentHash) {
      driftErrors.push({
        type: "DRIFT",
        entity: `${entry.ref.kind}:${entry.ref.id}`,
        expected: entry.currentHash,
        actual: currentCombined,
      });
    }
  }

  if (driftErrors.length > 0) {
    removePlan(scope, planId);
    return {
      ok: false,
      failed: driftErrors.map((d) => ({
        ref: parseEntityKey(d.entity),
        error: `DRIFT: content changed since plan was created`,
      })),
    };
  }

  commitsPaused = true;
  const failed: { ref: EntityRef; error: string }[] = [];

  try {
    for (const entry of plan.entries) {
      try {
        for (const file of entry.files) {
          const absPath = join(workTree, file.relPath);
          if (file.targetContent === null) {
            if (existsSync(absPath)) unlinkSync(absPath);
          } else {
            const dir = dirname(absPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(absPath, file.targetContent);
          }
        }
      } catch (err: any) {
        failed.push({ ref: entry.ref, error: err.message });
      }
    }

    const record = await commitIfChanged(scope, actor);

    if (record) {
      record.isRestore = true;
      await patchCommitMessage(scope, record, plan, failed.length > 0);

      const db = getIndex(scope);
      if (db) {
        const entityOps = new Map<string, string>();
        for (const entry of plan.entries) {
          const key = `${entry.ref.kind}:${entry.ref.id}`;
          const hasTarget = entry.files.some((f) => f.targetContent !== null);
          const hasCurrent = entry.files.some((f) => f.currentContent !== null);
          if (!hasCurrent && hasTarget) entityOps.set(key, "add");
          else if (hasCurrent && !hasTarget) entityOps.set(key, "delete");
          else entityOps.set(key, "modify");
        }
        const updatedRecord: CommitRecord = {
          ...record,
          summary: `Restore: ${plan.entries.length} ${plan.entries.length === 1 ? "entity" : "entities"} → ${plan.target.type === "change" ? `change ${plan.resolvedChangeId.slice(0, 8)}` : `timestamp ${plan.target.at}`}`,
          isRestore: true,
        };
        indexCommit(db, updatedRecord, entityOps);
      }
    }

    removePlan(scope, planId);
    return {
      ok: failed.length === 0,
      changeRecord: record ?? undefined,
      partial: failed.length > 0 ? true : undefined,
      failed: failed.length > 0 ? failed : undefined,
    };
  } finally {
    commitsPaused = false;
  }
}

// ── Discard ──

export function discardPlan(scope: ShadowScope, planId: string): void {
  const plan = readPlan(scope, planId);
  if (!plan) throw new Error("plan not found or expired");
  removePlan(scope, planId);
}

// ── Helpers ──

async function resolveTarget(
  scope: ShadowScope,
  db: Database,
  target: RestoreTarget,
): Promise<string | null> {
  if (target.type === "change") {
    const record = getChange(db, target.changeId);
    return record?.id ?? null;
  }

  const rows = db.prepare(
    `SELECT id FROM commits WHERE ts <= ? ORDER BY ts DESC LIMIT 1`,
  ).all(target.at) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

function listCurrentFiles(workTree: string, scope: ShadowScope): string[] {
  const files: string[] = [];
  walkDir(workTree, (absPath) => {
    if (isTracked(absPath, scope, workTree)) {
      files.push(relative(workTree, absPath).split(sep).join("/"));
    }
  });
  return files;
}

function walkDir(dir: string, cb: (absPath: string) => void): void {
  if (!existsSync(dir)) return;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === ".history" || entry.name === "node_modules" || entry.name === "pending-plans") continue;
      walkDir(full, cb);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

function parseEntityKey(key: string): EntityRef {
  const idx = key.indexOf(":");
  return {
    kind: key.slice(0, idx) as EntityKind,
    id: key.slice(idx + 1),
  };
}

async function patchCommitMessage(
  scope: ShadowScope,
  record: CommitRecord,
  plan: RestorePlan,
  partial: boolean,
): Promise<void> {
  // We can't easily amend the commit message after the fact via commitIfChanged,
  // but we can use the git raw interface. Import simpleGit inline to avoid
  // exposing it as a module-level dependency.
  const { simpleGit } = await import("simple-git");
  const workTree = getWorkTree(scope);
  const gitDir = join(shadowRepoPath(scope), ".git");
  const g = simpleGit({ baseDir: workTree, allowEnvironment: ["GIT_DIR"], config: [`core.worktree=${workTree}`] })
    .env("GIT_DIR", gitDir);

  const entityList = plan.entries.map((e) => `  ${e.ref.kind}:${e.ref.id}`).join("\n");
  const targetDesc = plan.target.type === "change"
    ? `change ${plan.resolvedChangeId.slice(0, 8)}`
    : `timestamp ${plan.target.at}`;

  const lines = [
    `Restore: ${plan.entries.length} ${plan.entries.length === 1 ? "entity" : "entities"} → ${targetDesc}`,
    "",
    "Entities:",
    entityList,
    "",
    `Is-Restore: true`,
    `Restore-Target: ${plan.resolvedChangeId}`,
  ];
  if (partial) lines.push("Partial: true");

  if (record.actor) {
    lines.push(`Actor-Type: ${record.actor.type}`);
    if (record.actor.name) lines.push(`Actor-Name: ${record.actor.name}`);
    if (record.actor.sessionId) lines.push(`Actor-Session: ${record.actor.sessionId}`);
  }

  await g.raw(["commit", "--amend", "-m", lines.join("\n")]);
}
