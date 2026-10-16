import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("config pages without a project", () => {
  test("lists harness and plugin pages but no project-owned pages", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-pages-projectless-"));
    const modusHome = join(root, "home");
    const resources = join(root, "resources");
    const project = join(root, "project");
    const plugin = join(root, "demo-plugin");
    const grid = { kind: "grid", children: [] };

    try {
      writeJson(join(resources, "plugin.json"), {
        id: "modus-core",
        name: "Modus Core",
        integration: { agentProfiles: [] },
      });
      writeJson(join(resources, "pages", "chat-studio.json"), {
        id: "chat-studio", title: "Chat Studio", nav: false, layout: grid,
      });
      writeJson(join(modusHome, "plugins.json"), {
        plugins: [{ id: "demo", path: plugin, enabled: true }],
      });
      writeJson(join(plugin, ".modus", "plugin.json"), {
        id: "demo",
        name: "Demo",
        integration: { pages: ["plugin-page"] },
      });
      writeJson(join(plugin, ".modus", "pages", "plugin.json"), {
        id: "plugin-page", title: "Plugin", layout: grid,
      });
      writeJson(join(project, ".modus", "pages", "project.json"), {
        id: "project-page", title: "Project", layout: grid,
      });

      const pagesUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "pages.ts")).href;
      const script = `
        const pages = await import(${JSON.stringify(pagesUrl)});
        const ids = (list) => list.map((page) => page.id).sort();
        console.log("RESULT:" + JSON.stringify({
          none: ids(pages.listConfigPages()),
          empty: ids(pages.listConfigPages("")),
          project: ids(pages.listConfigPages(${JSON.stringify(project)})),
        }));
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
          HARNESS_SECRETS_FILE: join(root, "secrets.json"),
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
      const resultLine = stdout.split(/\r?\n/).find((line) => line.startsWith("RESULT:"));
      expect(resultLine, stdout).toBeDefined();
      const result = JSON.parse(resultLine!.slice("RESULT:".length));

      expect(result.none).toEqual(["chat-studio", "plugin-page"]);
      expect(result.empty).toEqual(["chat-studio", "plugin-page"]);
      expect(result.project).toEqual(["chat-studio", "plugin-page", "project-page"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
