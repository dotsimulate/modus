import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

describe("project initialization", () => {
  test("scaffolds merge surfaces without seeding core profiles or skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-init-"));
    const target = join(root, "project");
    const resources = join(root, "resources");
    const modusHome = join(root, "home");
    mkdirSync(target, { recursive: true });
    const profileTemplate = join(resources, "templates", "profiles", "agents", "modus-helper.json");
    const skillTemplate = join(resources, "templates", "skills", "create-profile", "SKILL.md");
    mkdirSync(dirname(profileTemplate), { recursive: true });
    mkdirSync(dirname(skillTemplate), { recursive: true });
    writeFileSync(profileTemplate, "{}\n");
    writeFileSync(skillTemplate, "# create profile\n");

    try {
      const homeUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "modus-home.ts")).href;
      const initUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "init.ts")).href;
      const script = `
        const home = await import(${JSON.stringify(homeUrl)});
        home.ensureHomeLayout();
        const init = await import(${JSON.stringify(initUrl)});
        const result = init.initProject(${JSON.stringify(target)}, { name: "Test" });
        console.log("RESULT:" + JSON.stringify(result));
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          MODUS_HOME: modusHome,
          MODUS_RESOURCES_DIR: resources,
          MODUS_DATA_DIR: join(root, "data"),
          MODUS_LOGS_DIR: join(root, "logs"),
          MODUS_RUNTIME_DIR: join(root, "runtime"),
          MODUS_CACHE_DIR: join(root, "cache"),
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
      expect(stdout).toContain("RESULT:");
      expect(existsSync(join(target, ".modus", "moves"))).toBe(true);
      expect(existsSync(join(target, ".modus", "pages"))).toBe(true);
      expect(existsSync(join(target, ".modus", "ui", "extensions"))).toBe(true);
      expect(existsSync(join(target, ".modus", "profiles", "agents", "modus-helper.json"))).toBe(false);
      expect(existsSync(join(target, ".claude", "skills", "create-profile", "SKILL.md"))).toBe(false);
      const globalConfig = JSON.parse(readFileSync(join(target, ".modus", "_global.json"), "utf-8"));
      expect(globalConfig).toEqual({ mcpServers: {}, notificationChannels: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
