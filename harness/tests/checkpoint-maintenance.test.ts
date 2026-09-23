import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { applyCheckpointMaintenance, planCheckpointMaintenance, selectCheckpointRows } from "../checkpoint-maintenance";
import type { CheckpointRow } from "../db";

function row(id: number, createdAt: number, bytes: number | null, session = `s${id}`): CheckpointRow {
  return {
    id,
    session_id: session,
    seq: id,
    commit_hash: `hash-${id}`,
    cwd: "/repo",
    manifest_json: bytes == null ? null : JSON.stringify({ version: 2, totalBytes: bytes, entries: [], excluded: [] }),
    created_at: createdAt,
  };
}

const policy = { maxRepositoryBytes: 100, retentionDays: 30, maxRetainedCheckpoints: 2 };

describe("checkpoint maintenance planning", () => {
  test("drops legacy, expired, over-count, and over-budget rows", () => {
    const now = 40 * 86_400_000;
    const result = selectCheckpointRows([
      row(1, now - 1, 60),
      row(2, now - 2, 60),
      row(3, now - 3, null),
      row(4, 0, 10),
    ], policy, now);
    expect(result.keep.map((entry) => entry.id)).toEqual([1]);
    expect(result.prune.map((entry) => entry.id)).toEqual([2, 3, 4]);
  });

  test("protects the newest managed checkpoint for an active session", () => {
    const result = selectCheckpointRows([
      row(1, 0, 120, "active"),
      row(2, 1, 10, "active"),
    ], policy, 40 * 86_400_000, new Set(["active"]));
    expect(result.keep.map((entry) => entry.id)).toEqual([2]);
    expect(result.protectedIds).toEqual([2]);
  });

  test("produces a stable dry-run plan without applying changes", () => {
    const first = planCheckpointMaintenance({ rows: [row(1, 1, 10)], now: 2, policy, checkpointsDir: "/missing" });
    const second = planCheckpointMaintenance({ rows: [row(1, 1, 10)], now: 2, policy, checkpointsDir: "/missing" });
    expect(first.dryRun).toBe(true);
    expect(first.planId).toBe(second.planId);
    expect(first.totals.keepRows).toBe(1);
  });

  test("applies only an exact plan and preserves retained checkpoint trees", () => {
    const temp = mkdtempSync(join(tmpdir(), "modus-maintenance-"));
    const cwd = join(temp, "workspace");
    const checkpoints = join(temp, "checkpoints");
    mkdirSync(cwd);
    mkdirSync(checkpoints);
    const run = (args: string[], gitDir = cwd) => execFileSync("git", args, {
      cwd: gitDir, encoding: "utf8", windowsHide: true,
    }).trim();
    try {
      run(["init", "-b", "main"]);
      run(["config", "user.name", "test"]);
      run(["config", "user.email", "test@example.com"]);
      writeFileSync(join(cwd, "file.txt"), "old");
      run(["add", "file.txt"]);
      run(["commit", "-m", "old"]);
      const oldHash = run(["rev-parse", "HEAD"]);
      writeFileSync(join(cwd, "file.txt"), "new");
      run(["commit", "-am", "new"]);
      const newHash = run(["rev-parse", "HEAD"]);
      const newTree = run(["rev-parse", "HEAD^{tree}"]);

      let normalized = resolve(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
      if (process.platform === "win32") normalized = normalized.toLowerCase();
      const repo = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      run(["clone", "--bare", cwd, join(checkpoints, repo)], temp);

      const db = new Database(":memory:");
      db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
      db.run("CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, commit_hash TEXT NOT NULL, cwd TEXT NOT NULL, manifest_json TEXT, created_at INTEGER NOT NULL)");
      db.run("INSERT INTO sessions VALUES ('s1', 'done'), ('s2', 'idle')");
      const manifest = (bytes: number) => JSON.stringify({ version: 2, totalBytes: bytes, entries: [], excluded: [] });
      db.run("INSERT INTO checkpoints VALUES (1, 's1', 1, ?, ?, ?, 1)", [oldHash, normalized, manifest(10)]);
      db.run("INSERT INTO checkpoints VALUES (2, 's2', 2, ?, ?, ?, 2)", [newHash, normalized, manifest(10)]);
      const policy = { maxRepositoryBytes: 1000, retentionDays: 30, maxRetainedCheckpoints: 1 };
      const plan = planCheckpointMaintenance({
        rows: db.query("SELECT * FROM checkpoints").all() as CheckpointRow[],
        checkpointsDir: checkpoints,
        policy,
        now: 2,
        protectedSessionIds: new Set(["s2"]),
      });
      expect(() => applyCheckpointMaintenance({
        db, expectedPlanId: "wrong", checkpointsDir: checkpoints, policy, now: 2,
      })).toThrow("checkpoint plan changed");
      const result = applyCheckpointMaintenance({
        db, expectedPlanId: plan.planId, checkpointsDir: checkpoints, policy, now: 2,
      });
      expect(result.prunedRows).toBe(1);
      const retained = db.query("SELECT * FROM checkpoints").get() as CheckpointRow;
      expect(retained.id).toBe(2);
      expect(retained.commit_hash).not.toBe(newHash);
      expect(run(["--git-dir", join(checkpoints, repo), "rev-parse", `${retained.commit_hash}^{tree}`], temp)).toBe(newTree);
      db.close();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);
});
