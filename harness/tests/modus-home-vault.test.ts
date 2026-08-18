import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

type HomePaths = {
  modusHome: string;
  profiles: string;
  history: string;
  checkpoints: string;
  historyExists: boolean;
};

async function readHomePaths(root: string, instance?: string): Promise<HomePaths> {
  const homeUrl = pathToFileURL(join(resolvePath(import.meta.dir, ".."), "modus-home.ts")).href;
  const script = `
    const { existsSync } = await import("fs");
    const home = await import(${JSON.stringify(homeUrl)});
    home.ensureHomeLayout();
    console.log("RESULT:" + JSON.stringify({
      modusHome: home.MODUS_HOME,
      profiles: home.homeProfilesDir(),
      history: home.homeHistoryDir(),
      checkpoints: home.homeCheckpointsDir(),
      historyExists: existsSync(home.homeHistoryDir()),
    }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      MODUS_HOME: join(root, "home"),
      MODUS_INSTANCE: instance ?? "",
      MODUS_RESOURCES_DIR: join(root, "resources"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const result = stdout.split(/\r?\n/).find((line) => line.startsWith("RESULT:"));
  expect(result, stdout).toBeDefined();
  return JSON.parse(result!.slice("RESULT:".length)) as HomePaths;
}

describe("Vault-scoped home paths", () => {
  test("keeps default history and checkpoints in the existing Modus home", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-home-vault-"));
    try {
      const paths = await readHomePaths(root);
      expect(paths.modusHome).toBe(resolvePath(root, "home"));
      expect(paths.profiles).toBe(resolvePath(root, "home", "profiles"));
      expect(paths.history).toBe(resolvePath(root, "home", "history"));
      expect(paths.checkpoints).toBe(resolvePath(root, "home", "checkpoints"));
      expect(paths.historyExists).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("moves only history and checkpoints beneath a named Vault root", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-home-vault-"));
    try {
      const paths = await readHomePaths(root, "private");
      expect(paths.modusHome).toBe(resolvePath(root, "home"));
      expect(paths.profiles).toBe(resolvePath(root, "home", "profiles"));
      expect(paths.history).toBe(resolvePath(root, "home", "private", "history"));
      expect(paths.checkpoints).toBe(resolvePath(root, "home", "private", "checkpoints"));
      expect(paths.historyExists).toBe(true);
      expect(existsSync(resolvePath(root, "home", "history"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
