import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

test("action runs persist completion answerer identity and telemetry", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-action-answerer-db-"));
  try {
    const proc = Bun.spawn([
      process.execPath,
      "run",
      join(import.meta.dir, "fixtures", "action-answerer-db-driver.ts"),
    ], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        MODUS_HOME: join(root, "home"),
        MODUS_CONFIG_DIR: join(root, "config"),
        MODUS_DATA_DIR: join(root, "data"),
        MODUS_LOGS_DIR: join(root, "logs"),
        MODUS_RUNTIME_DIR: join(root, "runtime"),
        MODUS_CACHE_DIR: join(root, "cache"),
        HARNESS_SECRETS_FILE: join(root, "config", "secrets.env"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const row = JSON.parse(stdout.trim().split(/\r?\n/).at(-1) ?? "null");
    expect(row.answerer).toBe("completion");
    expect(row.sessionId).toBeNull();
    expect(row.completion).toEqual({
      oneShotId: "os-db-1",
      provider: "litellm",
      model: "ornith",
      transport: "in-process",
      elapsedMs: 321,
      usage: { input: 12, output: 4, totalTokens: 16, costUsd: 0 },
      stopReason: "stop",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
