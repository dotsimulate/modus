import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeSkill(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "# Create Mission\n");
}

async function gatherInIsolatedProject(root: string): Promise<string> {
  const project = join(root, "project");
  const contextUrl = pathToFileURL(join(import.meta.dir, "..", "moves", "create-mission", "context.ts")).href;
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });

  const child = Bun.spawn([process.execPath, "-e", `
    const { gather } = await import(${JSON.stringify(contextUrl)});
    const prompt = await gather({ cwd: ${JSON.stringify(project)}, date: "2026-09-23" });
    console.log("RESULT:" + JSON.stringify(prompt));
    process.exit(0);
  `], {
    env: {
      ...process.env,
      MODUS_INSTANCE: "default",
      MODUS_VAULT_ROOT: "",
      MODUS_HOME: join(root, "home"),
      HARNESS_SECRETS_FILE: join(root, "home", "secrets.env"),
      MODUS_RESOURCES_DIR: join(root, "resources"),
      MODUS_DATA_DIR: join(root, "data"),
      MODUS_LOGS_DIR: join(root, "logs"),
      MODUS_RUNTIME_DIR: join(root, "runtime"),
      MODUS_CACHE_DIR: join(root, "cache"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
      TEMP: join(root, "tmp"),
      TMP: join(root, "tmp"),
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
  const result = stdout.split("\n").find((line) => line.startsWith("RESULT:"));
  expect(result, stdout + stderr).toBeDefined();
  return JSON.parse(result!.slice("RESULT:".length));
}

describe("create-mission skill discovery", () => {
  test("a fresh project uses the packaged skill outside its cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-create-mission-"));
    const packaged = join(root, "resources", "templates", "skills", "create-mission", "SKILL.md");
    writeSkill(packaged);
    try {
      const prompt = await gatherInIsolatedProject(root);
      expect(prompt).toContain(`Create-mission skill path: ${packaged}`);
      expect(prompt).toContain(`Read and follow the create-mission skill at \`${packaged}\``);
      expect(prompt).not.toContain("No readable create-mission skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a project-local skill overrides the packaged skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-create-mission-"));
    const packaged = join(root, "resources", "templates", "skills", "create-mission", "SKILL.md");
    const local = join(root, "project", ".claude", "skills", "create-mission", "SKILL.md");
    writeSkill(packaged);
    writeSkill(local);
    try {
      const prompt = await gatherInIsolatedProject(root);
      expect(prompt).toContain(`Create-mission skill path: ${local}`);
      expect(prompt).not.toContain(packaged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a project Modus skill overrides the packaged skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-create-mission-"));
    const packaged = join(root, "resources", "templates", "skills", "create-mission", "SKILL.md");
    const local = join(root, "project", ".modus", "skills", "create-mission", "SKILL.md");
    writeSkill(packaged);
    writeSkill(local);
    try {
      const prompt = await gatherInIsolatedProject(root);
      expect(prompt).toContain(`Create-mission skill path: ${local}`);
      expect(prompt).not.toContain(packaged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an absent skill is reported without inventing a path", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-create-mission-"));
    try {
      const prompt = await gatherInIsolatedProject(root);
      expect(prompt).toContain("Create-mission skill path: unavailable");
      expect(prompt).toContain("No readable create-mission skill is available");
      expect(prompt).toContain("do not claim to have followed a skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
