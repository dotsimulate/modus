import { simpleGit } from "simple-git";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "fs";
import { join, relative, sep } from "path";
import { homeHistoryDir, homeProfilesDir } from "./modus-home";
import { isTracked } from "./workspace-history-filter";
import { projectEntities, userEntities, type EntityRef } from "./workspace-entities";

// ── Types ──

export type ShadowScope =
  | { kind: "project"; projectId: string }
  | { kind: "user" };

export type ActorInfo = {
  type: "human" | "agent";
  name?: string;
  sessionId?: string;
};

export type CommitRecord = {
  id: string;
  ts: string;
  summary: string;
  entities: EntityRef[];
  actor?: ActorInfo;
  isRestore?: boolean;
};

type AttributionHint = {
  path: string;
  actor: ActorInfo;
  ts: number;
};

// ── Commit hook — lets the index module subscribe without circular imports ──

type CommitHookFn = (scope: ShadowScope, record: CommitRecord, entityOps: Map<string, string>) => void;
let commitHook: CommitHookFn | null = null;

export function onShadowCommit(hook: CommitHookFn): void {
  commitHook = hook;
}

// ── Path helpers ──

export function shadowRepoPath(scope: ShadowScope): string {
  const key = scope.kind === "project" ? scope.projectId : "_user";
  return join(homeHistoryDir(), key);
}

function gitDir(scope: ShadowScope): string {
  return join(shadowRepoPath(scope), ".git");
}

function attributionDir(scope: ShadowScope): string {
  return join(shadowRepoPath(scope), "attribution");
}

// ── Work tree resolution ──

const workTrees = new Map<string, string>();

function getWorkTree(scope: ShadowScope): string {
  const key = scope.kind === "project" ? scope.projectId : "_user";
  const cached = workTrees.get(key);
  if (cached) return cached;
  if (scope.kind === "user") {
    workTrees.set(key, homeProfilesDir());
    return homeProfilesDir();
  }
  throw new Error(`Work tree not registered for project ${scope.projectId}`);
}

// ── Git helpers ──

function git(scope: ShadowScope) {
  return simpleGit({
    baseDir: getWorkTree(scope),
    allowEnvironment: ["GIT_DIR"],
    config: [
      `core.worktree=${getWorkTree(scope)}`,
    ],
  }).env("GIT_DIR", gitDir(scope));
}

// ── Git utilities for index/diff modules ──

export async function gitShowFile(scope: ShadowScope, commitId: string, relPath: string): Promise<string | null> {
  try {
    return await git(scope).raw(["show", `${commitId}:${relPath}`]);
  } catch {
    return null;
  }
}

export async function gitDiffTree(scope: ShadowScope, commitId: string): Promise<{ op: string; path: string }[]> {
  try {
    const raw = await git(scope).raw(["diff-tree", "--no-commit-id", "-r", "--name-status", "--root", commitId]);
    return raw.trim().split("\n").filter(Boolean).map((line) => {
      const parts = line.split("\t");
      return { op: parts[0]!.charAt(0), path: parts[1]! };
    });
  } catch {
    return [];
  }
}

export async function gitHead(scope: ShadowScope): Promise<string | null> {
  try {
    return (await git(scope).raw(["rev-parse", "HEAD"])).trim();
  } catch {
    return null;
  }
}

export async function gitLsTree(scope: ShadowScope, commitId: string, prefix?: string): Promise<string[]> {
  try {
    const args = ["ls-tree", "-r", "--name-only", commitId];
    if (prefix) args.push("--", prefix);
    const raw = await git(scope).raw(args);
    return raw.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export { getWorkTree };

// ── Init ──

export async function initShadowRepo(scope: ShadowScope, workTree: string): Promise<void> {
  const key = scope.kind === "project" ? scope.projectId : "_user";
  workTrees.set(key, workTree);

  const gd = gitDir(scope);
  const repoDir = shadowRepoPath(scope);

  if (!existsSync(repoDir)) mkdirSync(repoDir, { recursive: true });

  const isNew = !existsSync(gd);
  if (isNew) {
    const g = simpleGit({ baseDir: workTree, allowEnvironment: ["GIT_DIR"] });
    await g.raw(["init", "--separate-git-dir", gd]);
    await g.env("GIT_DIR", gd).addConfig("user.name", "modus-history");
    await g.env("GIT_DIR", gd).addConfig("user.email", "history@modus.local");
  }

  // Verify HEAD is valid — if repo existed but is corrupt, reinit
  try {
    await git(scope).raw(["rev-parse", "HEAD"]);
    // Existing repo with valid HEAD — no baseline needed
    return;
  } catch {
    if (!isNew) {
      // Corrupt repo — wipe and reinit
      rmSync(gd, { recursive: true, force: true });
      const g = simpleGit({ baseDir: workTree, allowEnvironment: ["GIT_DIR"] });
      await g.raw(["init", "--separate-git-dir", gd]);
      await g.env("GIT_DIR", gd).addConfig("user.name", "modus-history");
      await g.env("GIT_DIR", gd).addConfig("user.email", "history@modus.local");
    }
  }

  // Baseline commit — add all currently tracked files
  const trackedFiles = collectTrackedFiles(scope, workTree);
  if (trackedFiles.length === 0) {
    // Empty work tree — create an empty initial commit
    await git(scope).raw(["commit", "--allow-empty", "-m", "Baseline: empty workspace"]);
    return;
  }

  await git(scope).raw(["add", "--", ...trackedFiles]);
  const status = await git(scope).status();
  if (status.staged.length > 0 || status.created.length > 0) {
    await git(scope).raw(["commit", "-m", "Baseline: initial tracked state"]);
  } else {
    await git(scope).raw(["commit", "--allow-empty", "-m", "Baseline: initial tracked state"]);
  }
}

// ── Collect tracked files ──

function collectTrackedFiles(scope: ShadowScope, workTree: string): string[] {
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
      if (entry.name === ".git" || entry.name === ".history" || entry.name === "node_modules") continue;
      walkDir(full, cb);
    } else if (entry.isFile()) {
      cb(full);
    }
  }
}

// ── Attribution hints ──

export function recordAttributionHint(scope: ShadowScope, path: string, actor: ActorInfo): void {
  const dir = attributionDir(scope);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = Buffer.from(path).toString("base64url");
  const hint: AttributionHint = { path, actor, ts: Date.now() };
  writeFileSync(join(dir, `${key}.json`), JSON.stringify(hint));
}

function consumeAttributionHints(scope: ShadowScope): Map<string, ActorInfo> {
  const dir = attributionDir(scope);
  const result = new Map<string, ActorInfo>();
  if (!existsSync(dir)) return result;

  const TTL_MS = 30_000;
  const now = Date.now();

  let entries;
  try { entries = readdirSync(dir); } catch { return result; }

  for (const file of entries) {
    if (!file.endsWith(".json")) continue;
    const filePath = join(dir, file);
    try {
      const hint = JSON.parse(readFileSync(filePath, "utf-8")) as AttributionHint;
      if (now - hint.ts < TTL_MS) {
        result.set(hint.path, hint.actor);
      }
      unlinkSync(filePath);
    } catch {
      try { unlinkSync(filePath); } catch { /* best effort */ }
    }
  }
  return result;
}

// ── Commit ──

export async function commitIfChanged(
  scope: ShadowScope,
  attribution?: ActorInfo,
): Promise<CommitRecord | null> {
  const workTree = getWorkTree(scope);
  const trackedFiles = collectTrackedFiles(scope, workTree);

  // Stage tracked files — also handles deletions via --all on tracked paths
  if (trackedFiles.length > 0) {
    await git(scope).raw(["add", "--", ...trackedFiles]);
  }

  // Detect deleted files: files git knows about that are no longer tracked
  try {
    const lsFiles = await git(scope).raw(["ls-files"]);
    const gitKnown = lsFiles.split("\n").filter(Boolean);
    const trackedSet = new Set(trackedFiles);
    const removed = gitKnown.filter((f) => !trackedSet.has(f) && !existsSync(join(workTree, f)));
    if (removed.length > 0) {
      await git(scope).raw(["rm", "--cached", "--", ...removed]);
    }
  } catch { /* best effort */ }

  const status = await git(scope).status();
  const changedFiles = [
    ...status.staged,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];

  if (changedFiles.length === 0) {
    await git(scope).raw(["reset", "HEAD"]).catch(() => {});
    return null;
  }

  // Classify file-level operations
  const createdSet = new Set(status.created);
  const deletedSet = new Set(status.deleted);

  // Resolve entities from changed files and compute per-entity ops
  const entityMap = new Map<string, EntityRef>();
  const entityOps = new Map<string, string>();
  for (const relPath of changedFiles) {
    const absPath = join(workTree, relPath);
    const refs = scope.kind === "project"
      ? projectEntities(absPath, workTree)
      : userEntities(absPath, workTree);

    const fileOp = createdSet.has(relPath) ? "add" : deletedSet.has(relPath) ? "delete" : "modify";

    for (const ref of refs) {
      const key = `${ref.kind}:${ref.id}`;
      entityMap.set(key, ref);
      const existing = entityOps.get(key);
      if (!existing) {
        entityOps.set(key, fileOp);
      } else if (existing !== fileOp && existing !== "modify") {
        entityOps.set(key, "modify");
      }
    }
  }
  const entities = Array.from(entityMap.values());

  // Resolve actor from attribution hints or fallback
  const hints = consumeAttributionHints(scope);
  let actor: ActorInfo | undefined = attribution;
  if (!actor && hints.size > 0) {
    actor = hints.values().next().value;
  }

  // Build commit message
  const summary = entities.length > 0
    ? `${entities.length} ${entities.length === 1 ? "entity" : "entities"} changed`
    : `${changedFiles.length} ${changedFiles.length === 1 ? "file" : "files"} changed`;

  const lines = [`Auto: ${summary}`, ""];
  if (entities.length > 0) {
    lines.push("Entities:");
    for (const e of entities) {
      lines.push(`  ${e.kind}:${e.id}`);
    }
    lines.push("");
  }
  if (actor) {
    lines.push(`Actor-Type: ${actor.type}`);
    if (actor.name) lines.push(`Actor-Name: ${actor.name}`);
    if (actor.sessionId) lines.push(`Actor-Session: ${actor.sessionId}`);
  }

  const message = lines.join("\n");
  await git(scope).raw(["commit", "-m", message]);

  const log = await git(scope).raw(["log", "-1", "--format=%H%n%aI"]);
  const [hash, ts] = log.trim().split("\n");

  const record: CommitRecord = { id: hash!, ts: ts!, summary, entities, actor };
  if (commitHook) {
    try { commitHook(scope, record, entityOps); } catch { /* index failure must not block commits */ }
  }
  return record;
}

// ── Read ──

export async function listCommits(
  scope: ShadowScope,
  opts?: { limit?: number; since?: string; until?: string },
): Promise<CommitRecord[]> {
  const { limit = 50, since, until } = opts ?? {};

  try {
    await git(scope).raw(["rev-parse", "HEAD"]);
  } catch {
    return [];
  }

  const args = ["log", `--max-count=${limit}`, "--format=---SHADOW-SEP---%n%H%n%aI%n%B---SHADOW-END---"];
  if (since) args.push(`--since=${since}`);
  if (until) args.push(`--until=${until}`);

  const raw = await git(scope).raw(args);
  return parseShadowLog(raw);
}

function parseShadowLog(raw: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  const chunks = raw.split("---SHADOW-SEP---").filter((s) => s.trim());

  for (const chunk of chunks) {
    const endIdx = chunk.indexOf("---SHADOW-END---");
    if (endIdx === -1) continue;

    const content = chunk.slice(0, endIdx).trim();
    const firstNl = content.indexOf("\n");
    const secondNl = content.indexOf("\n", firstNl + 1);
    if (firstNl === -1 || secondNl === -1) continue;

    const id = content.slice(0, firstNl);
    const ts = content.slice(firstNl + 1, secondNl);
    const body = content.slice(secondNl + 1);

    const entities = parseEntitiesFromBody(body);
    const actor = parseActorFromBody(body);
    const isRestore = body.includes("Is-Restore: true");

    const summaryLine = body.split("\n")[0] ?? "";
    const summary = summaryLine.startsWith("Auto: ")
      ? summaryLine.slice(6)
      : summaryLine;

    records.push({ id, ts, summary, entities, actor, isRestore: isRestore || undefined });
  }

  return records;
}

function parseEntitiesFromBody(body: string): EntityRef[] {
  const entities: EntityRef[] = [];
  const lines = body.split("\n");
  let inEntities = false;

  for (const line of lines) {
    if (line.trim() === "Entities:") {
      inEntities = true;
      continue;
    }
    if (inEntities) {
      const match = line.match(/^\s{2}(\S+):(.+)$/);
      if (match) {
        entities.push({ kind: match[1] as EntityRef["kind"], id: match[2]! });
      } else {
        inEntities = false;
      }
    }
  }

  return entities;
}

function parseActorFromBody(body: string): ActorInfo | undefined {
  const typeMatch = body.match(/^Actor-Type:\s*(.+)$/m);
  if (!typeMatch) return undefined;

  const actor: ActorInfo = { type: typeMatch[1]!.trim() as ActorInfo["type"] };
  const nameMatch = body.match(/^Actor-Name:\s*(.+)$/m);
  if (nameMatch) actor.name = nameMatch[1]!.trim();
  const sessionMatch = body.match(/^Actor-Session:\s*(.+)$/m);
  if (sessionMatch) actor.sessionId = sessionMatch[1]!.trim();

  return actor;
}

// ── Debounce infrastructure ──

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 2000;

function scopeKey(scope: ShadowScope): string {
  return scope.kind === "project" ? `project:${scope.projectId}` : "user";
}

let commitsPausedFn: (() => boolean) | null = null;

export function setCommitsPausedCheck(fn: () => boolean): void {
  commitsPausedFn = fn;
}

export function scheduleCommit(scope: ShadowScope, attribution?: ActorInfo): void {
  if (commitsPausedFn?.()) return;

  const key = scopeKey(scope);
  const existing = debounceTimers.get(key);
  if (existing) return; // fixed window — first event starts the timer, subsequent events are batched

  debounceTimers.set(key, setTimeout(async () => {
    debounceTimers.delete(key);
    if (commitsPausedFn?.()) return;
    try {
      const record = await commitIfChanged(scope, attribution);
      if (record) {
        console.log(`[workspace-history] committed ${record.summary} (${record.id.slice(0, 8)}) [${key}]`);
      }
    } catch (err: any) {
      console.warn(`[workspace-history] commit failed [${key}]: ${err.message}`);
    }
  }, DEBOUNCE_MS));
}
