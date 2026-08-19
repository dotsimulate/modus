import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

type HomePaths = {
  modusHome: string;
  profiles: string;
  history: string;
  checkpoints: string;
  historyExists: boolean;
};

type RehydrationResult = {
  copiedFromLegacy: string[];
  copiedFromTemplates: string[];
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readHomePaths(root: string, instance?: string): Promise<HomePaths> {
  const selectedHome = instance ? join(root, "chosen-vault") : join(root, "home");
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
      MODUS_VAULT_ROOT: instance ? join(root, "chosen-vault") : "",
      MODUS_RESOURCES_DIR: join(root, "resources"),
      MODUS_DATA_DIR: join(selectedHome, "data"),
      MODUS_LOGS_DIR: join(selectedHome, "logs"),
      MODUS_RUNTIME_DIR: join(selectedHome, "runtime"),
      MODUS_CACHE_DIR: join(selectedHome, "cache"),
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

async function rehydrateFixture(root: string, instance?: string): Promise<RehydrationResult> {
  const resources = join(root, "resources");
  const selectedHome = instance ? join(root, "named") : join(root, "main");
  writeJson(join(resources, "profiles", "agents", "legacy-authored.json"), { prompt: "legacy" });
  writeJson(join(resources, "profiles", "_projects.json"), {
    legacy: { name: "Legacy", path: join(root, "legacy-project"), created: "2026-08-19T00:00:00.000Z" },
  });
  writeJson(join(resources, "templates", "profiles", "agents", "shipped.json"), { prompt: "shipped" });
  const rehydrateUrl = pathToFileURL(join(resolvePath(import.meta.dir, ".."), "modus-home-rehydrate.ts")).href;
  const script = `
    const rehydrate = await import(${JSON.stringify(rehydrateUrl)});
    console.log("RESULT:" + JSON.stringify(rehydrate.rehydrateHome()));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      MODUS_HOME: join(root, "main"),
      MODUS_INSTANCE: instance ?? "",
      MODUS_VAULT_ROOT: instance ? selectedHome : "",
      MODUS_RESOURCES_DIR: resources,
      MODUS_DATA_DIR: join(selectedHome, "data"),
      MODUS_LOGS_DIR: join(selectedHome, "logs"),
      MODUS_RUNTIME_DIR: join(selectedHome, "runtime"),
      MODUS_CACHE_DIR: join(selectedHome, "cache"),
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
  return JSON.parse(result!.slice("RESULT:".length)) as RehydrationResult;
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
  }, 15_000);

  test("moves the complete home layout into the chosen named Vault root", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-home-vault-"));
    try {
      const paths = await readHomePaths(root, "private");
      expect(paths.modusHome).toBe(resolvePath(root, "chosen-vault"));
      expect(paths.profiles).toBe(resolvePath(root, "chosen-vault", "profiles"));
      expect(paths.history).toBe(resolvePath(root, "chosen-vault", "history"));
      expect(paths.checkpoints).toBe(resolvePath(root, "chosen-vault", "checkpoints"));
      expect(paths.historyExists).toBe(true);
      expect(existsSync(resolvePath(root, "home", "history"))).toBe(false);
      expect(existsSync(resolvePath(root, "home", "profiles"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("migrates legacy authored resources into Main but seeds named Vaults from shipped templates only", async () => {
    const mainFixture = mkdtempSync(join(tmpdir(), "modus-home-rehydrate-main-"));
    const namedFixture = mkdtempSync(join(tmpdir(), "modus-home-rehydrate-named-"));
    try {
      const main = await rehydrateFixture(mainFixture);
      expect(main.copiedFromLegacy.length).toBe(2);
      expect(existsSync(join(mainFixture, "main", "profiles", "agents", "legacy-authored.json"))).toBe(true);
      expect(existsSync(join(mainFixture, "main", "projects.json"))).toBe(true);
      expect(readFileSync(join(mainFixture, "main", "profiles", "agents", "shipped.json"), "utf8"))
        .toContain("shipped");

      const named = await rehydrateFixture(namedFixture, "private");
      expect(named.copiedFromLegacy).toEqual([]);
      expect(existsSync(join(namedFixture, "named", "profiles", "agents", "legacy-authored.json"))).toBe(false);
      expect(existsSync(join(namedFixture, "named", "projects.json"))).toBe(false);
      expect(readFileSync(join(namedFixture, "named", "profiles", "agents", "shipped.json"), "utf8"))
        .toContain("shipped");
      expect(existsSync(join(namedFixture, "main", "profiles"))).toBe(false);
    } finally {
      rmSync(mainFixture, { recursive: true, force: true });
      rmSync(namedFixture, { recursive: true, force: true });
    }
  }, 15_000);
});
