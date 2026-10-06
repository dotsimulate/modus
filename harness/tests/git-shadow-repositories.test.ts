import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

test("checkpoint and configuration restores keep Git writes in managed shadow repositories", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "modus-shadow-git-")));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  for (const key of ["MODUS_HOME", "MODUS_CONFIG_DIR", "MODUS_DATA_DIR", "MODUS_RUNTIME_DIR", "MODUS_LOGS_DIR", "MODUS_CACHE_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) {
    env[key] = join(root, key.toLowerCase());
    mkdirSync(env[key]!, { recursive: true });
  }
  env.HARNESS_SECRETS_FILE = join(root, "secrets.env");
  env.USERPROFILE = root;
  env.HOME = root;
  delete env.MODUS_INSTANCE;
  delete env.MODUS_VAULT_ROOT;
  const modulePath = (name: string) => JSON.stringify(resolve(import.meta.dir, "..", name));
  const script = `
    import assert from "node:assert/strict";
    import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
    import { join } from "node:path";
    const root = ${JSON.stringify(root)};
    const project = join(root, "project");
    mkdirSync(project);
    function git(...args) {
      const result = Bun.spawnSync(["git", ...args], { cwd: project });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      return result.stdout.toString().trim();
    }
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture owner");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    const file = join(project, "file.txt");
    writeFileSync(file, "before");
    git("add", ".");
    git("commit", "-q", "-m", "initial");
    const originalHead = git("rev-parse", "HEAD");
    const originalConfig = readFileSync(join(project, ".git", "config"), "utf8");
    const { upsertSession } = await import(${modulePath("db.ts")});
    const { captureCheckpoint, restoreCheckpointById } = await import(${modulePath("checkpoints.ts")});
    upsertSession({ id: "fixture", preview: "Fixture", messageCount: 0, costUsd: 0, cwd: project });
    const capture = await captureCheckpoint(project, "fixture", 1);
    assert.equal(capture.ok, true, JSON.stringify(capture));
    writeFileSync(file, "after");
    const restored = await restoreCheckpointById(capture.checkpointId, { sessionId: "fixture", seq: 2 });
    assert.equal(restored.status, "success", JSON.stringify(restored));
    assert.equal(readFileSync(file, "utf8"), "before");
    assert.equal(git("rev-parse", "HEAD"), originalHead);
    assert.equal(readFileSync(join(project, ".git", "config"), "utf8"), originalConfig);

    const configRoot = join(root, "config-worktree");
    mkdirSync(configRoot);
    const configFile = join(configRoot, "_global.json");
    writeFileSync(configFile, '{"theme":"before"}');
    const { initShadowRepo, commitIfChanged, gitHead, shadowRepoPath } = await import(${modulePath("workspace-history.ts")});
    const { openIndex, closeIndex, indexCommit } = await import(${modulePath("workspace-history-index.ts")});
    const { planRestore, applyRestore } = await import(${modulePath("workspace-history-restore.ts")});
    const scope = { kind: "project", projectId: "fixture" };
    await initShadowRepo(scope, configRoot);
    const before = await gitHead(scope);
    writeFileSync(configFile, '{"theme":"after"}');
    const change = await commitIfChanged(scope);
    assert(change);
    const index = openIndex(scope, shadowRepoPath(scope));
    indexCommit(index, { ...change, id: before }, new Map());
    const plan = await planRestore(scope, index, { type: "change", changeId: before }, "all");
    assert(plan.entries.length > 0);
    const result = await applyRestore(scope, plan.id, { type: "human", name: "Fixture" });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(readFileSync(configFile, "utf8"), '{"theme":"before"}');
    assert.notEqual(await gitHead(scope), before);
    closeIndex(scope);
    console.log("shadow restore checks passed");
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([process.execPath, "--eval", script], { env, stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 30_000);
    try {
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, errors).toBe(0);
      expect(output).toContain("shadow restore checks passed");
    } finally { clearTimeout(timeout); }
  } finally {
    await removeTreeAfterExit(root);
  }
}, 45_000);
