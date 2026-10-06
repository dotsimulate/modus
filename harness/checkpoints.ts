/**
 * Bounded, path-managed workspace checkpoints.
 *
 * A checkpoint owns only the paths recorded in its manifest. Restore never
 * runs a whole-tree reset and never touches ignored, oversized, nested-repo,
 * or otherwise excluded paths. Old checkpoints without a v2 manifest are
 * intentionally non-restorable by this engine.
 */

import { simpleGit, type SimpleGit } from "simple-git";
import { createHash } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { homeCheckpointsDir } from "./modus-home";
import {
  insertCheckpoint,
  findCheckpointAtOrBefore,
  getCheckpointById,
  type CheckpointRow,
} from "./db";
import {
  checkpointMaintenancePolicy,
  checkpointRepositoryBytes,
} from "./checkpoint-maintenance";

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const MANIFEST_VERSION = 2 as const;

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export type CheckpointEntry = {
  path: string;
  bytes: number;
  sha256: string;
  kind: "file" | "symlink";
  origin: "tracked" | "untracked";
};

export type CheckpointExclusion = {
  path: string;
  reason: "oversized" | "total-limit" | "time-limit" | "directory" | "unreadable" | "unsafe-path";
  bytes?: number;
};

export type CheckpointManifest = {
  version: typeof MANIFEST_VERSION;
  root: string;
  entries: CheckpointEntry[];
  excluded: CheckpointExclusion[];
  totalBytes: number;
  limits: { maxFileBytes: number; maxTotalBytes: number };
};

export type RewindFileAction = {
  path: string;
  action: "restore" | "delete" | "provider-rewind";
  evidence: "modus-managed" | "native-provider";
  reason: "modified" | "missing" | "created-after-checkpoint" | "provider-reported";
};

export type RewindPreview = {
  capability: "modus" | "native-claude" | "unsupported";
  status: "ready" | "partial" | "unsupported";
  checkpointId?: number;
  files: RewindFileAction[];
  excluded: CheckpointExclusion[];
  unchangedCount: number;
  managedBytes: number;
  undoAvailable: boolean;
  scopeNotes: string[];
  error?: string;
};

export type RewindResult = {
  status: "success" | "partial" | "failed" | "unsupported";
  checkpointId?: number;
  undoCheckpointId?: number;
  restored: string[];
  deleted: string[];
  providerChanged?: string[];
  excluded: CheckpointExclusion[];
  error?: string;
};

export async function checkpointRoot(cwd: string): Promise<string | null> {
  try {
    const top = await simpleGit(cwd).revparse(["--show-toplevel"]);
    return top.trim() || null;
  } catch {
    return null;
  }
}

function normalizeRoot(cwd: string): string {
  let p = resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") p = p.toLowerCase();
  return p;
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return null;
  return parts.join("/");
}

function absoluteManagedPath(root: string, managedPath: string): string | null {
  const normalized = normalizeRelativePath(managedPath);
  if (!normalized) return null;
  const absolute = resolve(root, ...normalized.split("/"));
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return absolute;
}

export function shadowDirFor(cwd: string): string {
  const hash = createHash("sha256").update(normalizeRoot(cwd)).digest("hex").slice(0, 16);
  return join(homeCheckpointsDir(), hash);
}

function shadowGit(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd, allowEnvironment: ["GIT_DIR", "GIT_WORK_TREE"] }).env({
    GIT_DIR: shadowDirFor(cwd),
    GIT_WORK_TREE: cwd,
  });
}

const queues = new Map<string, Promise<unknown>>();

function serialize<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeRoot(cwd);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

async function ensureShadowRepo(cwd: string): Promise<void> {
  const dir = shadowDirFor(cwd);
  const isNew = !existsSync(join(dir, "HEAD"));
  if (isNew) {
    mkdirSync(dir, { recursive: true });
    await simpleGit(cwd).raw(["init", "--bare", dir]);
    writeFileSync(join(dir, "work-tree.txt"), normalizeRoot(cwd));
  }
  if (isNew) {
    const g = shadowGit(cwd);
    await g.raw(["config", "user.name", "modus-checkpoint"]);
    await g.raw(["config", "user.email", "checkpoint@modus.local"]);
    await g.raw(["config", "core.autocrlf", "false"]);
  }
}

function splitNul(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

function hashPath(absolute: string, kind: "file" | "symlink"): string {
  const data = kind === "symlink" ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
  return createHash("sha256").update(data).digest("hex");
}

async function collectManifest(root: string): Promise<CheckpointManifest> {
  const sourceGit = simpleGit(root);
  const tracked = splitNul(await sourceGit.raw(["ls-files", "--cached", "-z"]));
  const untracked = splitNul(await sourceGit.raw(["ls-files", "--others", "--exclude-standard", "-z"]));
  const candidates = [
    ...tracked.map((path) => ({ path, origin: "tracked" as const })),
    ...untracked.map((path) => ({ path, origin: "untracked" as const })),
  ];
  const seen = new Set<string>();
  const entries: CheckpointEntry[] = [];
  const excluded: CheckpointExclusion[] = [];
  const maxFileBytes = positiveEnvInt("MODUS_CHECKPOINT_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
  const maxTotalBytes = positiveEnvInt("MODUS_CHECKPOINT_MAX_TOTAL_BYTES", DEFAULT_MAX_TOTAL_BYTES);
  const captureTimeoutMs = positiveEnvInt("MODUS_CHECKPOINT_CAPTURE_TIMEOUT_MS", DEFAULT_CAPTURE_TIMEOUT_MS);
  const startedAt = Date.now();
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (Date.now() - startedAt > captureTimeoutMs) {
      excluded.push({ path: candidate.path, reason: "time-limit" });
      continue;
    }
    const path = normalizeRelativePath(candidate.path);
    if (!path || seen.has(path)) {
      if (!path) excluded.push({ path: candidate.path, reason: "unsafe-path" });
      continue;
    }
    seen.add(path);
    const absolute = absoluteManagedPath(root, path);
    if (!absolute) {
      excluded.push({ path, reason: "unsafe-path" });
      continue;
    }
    // A tracked path that is absent represents a deliberate deletion in this
    // snapshot. It must remain absent from the manifest/tree, not become an
    // exclusion that restore would protect.
    if (!existsSync(absolute)) continue;
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        excluded.push({ path, reason: "directory" });
        continue;
      }
      const kind = stat.isSymbolicLink() ? "symlink" as const : "file" as const;
      const bytes = kind === "symlink" ? Buffer.byteLength(readlinkSync(absolute)) : stat.size;
      if (bytes > maxFileBytes) {
        excluded.push({ path, reason: "oversized", bytes });
        continue;
      }
      if (totalBytes + bytes > maxTotalBytes) {
        excluded.push({ path, reason: "total-limit", bytes });
        continue;
      }
      entries.push({ path, bytes, sha256: hashPath(absolute, kind), kind, origin: candidate.origin });
      totalBytes += bytes;
    } catch {
      excluded.push({ path, reason: "unreadable" });
    }
  }

  return {
    version: MANIFEST_VERSION,
    root: normalizeRoot(root),
    entries,
    excluded,
    totalBytes,
    limits: { maxFileBytes, maxTotalBytes },
  };
}

function pathChunks(paths: string[], maxChars = 20_000): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (current.length > 0 && chars + path.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function parseManifest(row: CheckpointRow): CheckpointManifest | null {
  if (!row.manifest_json) return null;
  try {
    const parsed = JSON.parse(row.manifest_json) as CheckpointManifest;
    if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.entries) || !Array.isArray(parsed.excluded)) return null;
    if (parsed.entries.some((entry) => !normalizeRelativePath(entry.path))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type CaptureResult =
  | { ok: true; checkpointId: number; commitHash: string; changed: boolean; manifest: CheckpointManifest }
  | { ok: false; reason: string };

export async function captureCheckpoint(cwd: string, sessionId: string, seq: number): Promise<CaptureResult> {
  const root = await checkpointRoot(cwd);
  if (!root) return { ok: false, reason: "not a git repository" };

  return serialize(root, async () => {
    const policy = checkpointMaintenancePolicy();
    const repositoryBytes = checkpointRepositoryBytes(shadowDirFor(root));
    if (repositoryBytes > policy.maxRepositoryBytes) {
      return {
        ok: false as const,
        reason: `checkpoint repository exceeds ${policy.maxRepositoryBytes} bytes; run checkpoint maintenance before capturing more history`,
      };
    }
    await ensureShadowRepo(root);
    const manifest = await collectManifest(root);
    const g = shadowGit(root);

    // Build an exact index from the manifest. Never stage the whole worktree.
    await g.raw(["read-tree", "--empty"]);
    for (const chunk of pathChunks(manifest.entries.map((entry) => entry.path))) {
      await g.raw(["add", "-f", "--", ...chunk]);
    }

    const treeHash = (await g.raw(["write-tree"])).trim();
    let previousTree: string | null = null;
    try { previousTree = (await g.raw(["rev-parse", "HEAD^{tree}"])).trim(); } catch { /* first checkpoint */ }
    const changed = treeHash !== previousTree;
    if (changed || !previousTree) {
      await g.raw(["commit", "--allow-empty", "-m", `checkpoint session=${sessionId} seq=${seq}`]);
    }
    const commitHash = (await g.raw(["rev-parse", "HEAD"])).trim();
    const checkpointId = insertCheckpoint({
      sessionId,
      seq,
      commitHash,
      cwd: normalizeRoot(root),
      manifestJson: JSON.stringify(manifest),
    });
    return { ok: true as const, checkpointId, commitHash, changed, manifest };
  });
}

function unsupportedPreview(error: string): RewindPreview {
  return {
    capability: "unsupported",
    status: "unsupported",
    files: [],
    excluded: [],
    unchangedCount: 0,
    managedBytes: 0,
    undoAvailable: false,
    scopeNotes: [],
    error,
  };
}

export async function previewCheckpoint(checkpointId: number): Promise<RewindPreview> {
  const row = getCheckpointById(checkpointId);
  if (!row) return unsupportedPreview("checkpoint not found");
  const target = parseManifest(row);
  if (!target) return unsupportedPreview("legacy checkpoint has no managed-file manifest and will not be restored");
  const root = await checkpointRoot(row.cwd);
  if (!root || normalizeRoot(root) !== normalizeRoot(row.cwd)) {
    return unsupportedPreview("checkpoint workspace is unavailable or no longer resolves to the same Git repository");
  }

  const current = await collectManifest(root);
  const targetEntries = new Map(target.entries.map((entry) => [entry.path, entry]));
  const currentEntries = new Map(current.entries.map((entry) => [entry.path, entry]));
  const protectedPaths = new Set([...target.excluded, ...current.excluded].map((entry) => entry.path));
  const files: RewindFileAction[] = [];
  let unchangedCount = 0;

  for (const targetEntry of target.entries) {
    if (protectedPaths.has(targetEntry.path)) continue;
    const currentEntry = currentEntries.get(targetEntry.path);
    if (!currentEntry) {
      files.push({ path: targetEntry.path, action: "restore", evidence: "modus-managed", reason: "missing" });
    } else if (currentEntry.sha256 !== targetEntry.sha256 || currentEntry.kind !== targetEntry.kind) {
      files.push({ path: targetEntry.path, action: "restore", evidence: "modus-managed", reason: "modified" });
    } else {
      unchangedCount++;
    }
  }
  for (const currentEntry of current.entries) {
    if (!targetEntries.has(currentEntry.path) && !protectedPaths.has(currentEntry.path)) {
      files.push({ path: currentEntry.path, action: "delete", evidence: "modus-managed", reason: "created-after-checkpoint" });
    }
  }

  const excludedMap = new Map<string, CheckpointExclusion>();
  for (const entry of [...target.excluded, ...current.excluded]) excludedMap.set(entry.path, entry);
  const excluded = [...excludedMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    capability: "modus",
    status: excluded.length > 0 ? "partial" : "ready",
    checkpointId,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    excluded,
    unchangedCount,
    managedBytes: target.totalBytes,
    undoAvailable: true,
    scopeNotes: [
      "Only paths listed as Modus-managed are eligible for restore or deletion.",
      "Ignored files, excluded files, directories, and nested repositories are left untouched.",
    ],
  };
}

async function checkoutPaths(root: string, commitHash: string, paths: string[]): Promise<void> {
  const g = shadowGit(root);
  for (const chunk of pathChunks(paths)) await g.raw(["checkout", commitHash, "--", ...chunk]);
}

export async function restoreCheckpointById(
  checkpointId: number,
  undo: { sessionId: string; seq: number },
): Promise<RewindResult> {
  const row = getCheckpointById(checkpointId);
  if (!row) return { status: "unsupported", restored: [], deleted: [], excluded: [], error: "checkpoint not found" };
  if (!parseManifest(row)) {
    return { status: "unsupported", checkpointId, restored: [], deleted: [], excluded: [], error: "legacy checkpoint has no managed-file manifest" };
  }
  const root = await checkpointRoot(row.cwd);
  if (!root || normalizeRoot(root) !== normalizeRoot(row.cwd)) {
    return { status: "unsupported", checkpointId, restored: [], deleted: [], excluded: [], error: "checkpoint workspace is unavailable" };
  }

  return serialize(root, async () => {
    // Capture the exact managed state immediately before applying the restore.
    // Call the internal work outside this queue to avoid recursive serialization.
    await ensureShadowRepo(root);
    const safetyManifest = await collectManifest(root);
    const g = shadowGit(root);
    await g.raw(["read-tree", "--empty"]);
    for (const chunk of pathChunks(safetyManifest.entries.map((entry) => entry.path))) {
      await g.raw(["add", "-f", "--", ...chunk]);
    }
    const safetyTree = (await g.raw(["write-tree"])).trim();
    let headTree: string | null = null;
    try { headTree = (await g.raw(["rev-parse", "HEAD^{tree}"])).trim(); } catch { /* no head */ }
    if (safetyTree !== headTree || !headTree) {
      await g.raw(["commit", "--allow-empty", "-m", `checkpoint undo session=${undo.sessionId} seq=${undo.seq}`]);
    }
    const safetyHash = (await g.raw(["rev-parse", "HEAD"])).trim();
    const undoCheckpointId = insertCheckpoint({
      sessionId: undo.sessionId,
      seq: undo.seq,
      commitHash: safetyHash,
      cwd: normalizeRoot(root),
      manifestJson: JSON.stringify(safetyManifest),
    });

    const preview = await previewCheckpoint(checkpointId);
    if (preview.status === "unsupported") {
      return { status: "unsupported" as const, checkpointId, restored: [], deleted: [], excluded: [], error: preview.error };
    }
    const restorePaths = preview.files.filter((file) => file.action === "restore").map((file) => file.path);
    const deletePaths = preview.files.filter((file) => file.action === "delete").map((file) => file.path);
    try {
      if (restorePaths.length > 0) await checkoutPaths(root, row.commit_hash, restorePaths);
      for (const path of deletePaths) {
        const absolute = absoluteManagedPath(root, path);
        if (!absolute) throw new Error(`unsafe managed path: ${path}`);
        try { unlinkSync(absolute); } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      return {
        status: preview.status === "partial" ? "partial" as const : "success" as const,
        checkpointId,
        undoCheckpointId,
        restored: restorePaths,
        deleted: deletePaths,
        excluded: preview.excluded,
      };
    } catch (error: any) {
      return {
        status: "failed" as const,
        checkpointId,
        undoCheckpointId,
        restored: [],
        deleted: [],
        excluded: preview.excluded,
        error: error?.message ?? String(error),
      };
    }
  });
}

export function checkpointForSeq(sessionId: string, seq: number): CheckpointRow | undefined {
  return findCheckpointAtOrBefore(sessionId, seq);
}

export function checkpointById(id: number): CheckpointRow | undefined {
  return getCheckpointById(id);
}
