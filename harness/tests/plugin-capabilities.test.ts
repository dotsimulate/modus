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

describe("plugin capability contract", () => {
  test("resolves qualified profiles, merges config, and persists scoped settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-plugin-capabilities-"));
    const modusHome = join(root, "home");
    const resources = join(root, "resources");
    const project = join(root, "project");
    const plugin = join(root, "demo-plugin");

    try {
      writeJson(join(resources, "plugin.json"), {
        id: "modus-core",
        name: "Modus Core",
        integration: { agentProfiles: [] },
      });
      writeJson(join(modusHome, "plugins.json"), {
        plugins: [{ id: "demo", path: plugin, enabled: true }],
      });
      writeJson(join(modusHome, "projects.json"), {
        project: { name: "Project", path: project, created: "2026-07-26T00:00:00.000Z" },
      });
      writeJson(join(modusHome, "profiles", "agents", "same.json"), {
        prompt: "user",
      });
      mkdirSync(join(modusHome, "profiles", "ui", "users"), { recursive: true });
      writeJson(join(modusHome, "profiles", "_global.json"), {
        mcpServers: { shared: { command: "base" }, base: { command: "base" } },
        providerDefaults: { litellm: { contextWindow: 32_000 } },
      });
      writeJson(join(project, ".modus", "profiles", "agents", "same.json"), {
        prompt: "project",
      });
      writeJson(join(project, ".modus", "_global.json"), {
        mcpServers: { shared: { command: "project" }, project: { command: "project" } },
        providerDefaults: { litellm: { contextWindow: 128_000 } },
      });
      writeJson(join(plugin, ".modus", "plugin.json"), {
        id: "demo",
        name: "Demo",
        integration: {
          agentProfiles: ["same", "public"],
          pages: ["public-page", "move-public"],
        },
        settings: [
          { key: "hour", type: "number", scope: "user", default: 4 },
          { key: "open", type: "toggle", scope: "project", default: true },
          { key: "projects", type: "project-list", scope: "global", default: [] },
          { key: "secret", type: "secret-name", scope: "user", default: "" },
        ],
      });
      writeJson(join(plugin, ".modus", "profiles", "agents", "same.json"), {
        prompt: "plugin",
      });
      writeJson(join(plugin, ".modus", "profiles", "agents", "public.json"), {
        prompt: "public",
        cwd: "${pluginDir}",
        additionalDirectories: ["${pluginDir}/docs"],
        cwdSuggestions: ["${pluginDir}/examples"],
      });
      writeJson(join(plugin, ".modus", "profiles", "agents", "private.json"), {
        prompt: "private",
      });
      writeJson(join(plugin, ".modus", "_global.json"), {
        mcpServers: { shared: { command: "plugin" }, plugin: { command: "plugin" } },
        providerDefaults: { litellm: { contextWindow: 64_000 } },
      });
      writeJson(join(plugin, ".modus", "pages", "public.json"), {
        id: "public-page",
        title: "Public",
        layout: { kind: "grid", children: [] },
      });
      writeJson(join(plugin, ".modus", "pages", "private.json"), {
        id: "private-page",
        title: "Private",
        layout: { kind: "grid", children: [] },
      });
      writeJson(join(plugin, ".modus", "moves", "with-page", "move.json"), {
        name: "with-page",
        enabled: true,
        page: {
          id: "move-public",
          title: "Move Public",
          layout: { kind: "grid", children: [] },
        },
      });

      const profilesUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "profiles.ts")).href;
      const settingsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "plugin-settings.ts")).href;
      const pagesUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "pages.ts")).href;
      const script = `
        const profiles = await import(${JSON.stringify(profilesUrl)});
        const settings = await import(${JSON.stringify(settingsUrl)});
        const pages = await import(${JSON.stringify(pagesUrl)});
        const project = ${JSON.stringify(project)};
        const plugin = ${JSON.stringify(plugin)};
        const visible = profiles.getAllProfiles(project);
        const pluginLocal = profiles.getProfile("same", project, { pluginId: "demo" });
        const normalLocal = profiles.getProfile("same", project);
        const hidden = profiles.getProfile("private", project, { pluginId: "demo" });
        const publicProfile = profiles.getProfile("plugin:demo/public", project);
        const globalConfig = profiles.getGlobalConfig(project);
        const visiblePages = pages.listConfigPages(project);
        const before = settings.getPluginSettings("demo", { cwd: project, userProfile: "dot" });
        const after = settings.patchPluginSettings("demo", {
          hour: 7,
          open: false,
          projects: [project],
          secret: "ATLAS_TOKEN",
        }, { cwd: project, userProfile: "dot" });
        let secretRejected = false;
        let projectRejected = false;
        try {
          settings.patchPluginSettings("demo", { secret: "not a secret value!" }, { userProfile: "dot" });
        } catch { secretRejected = true; }
        try {
          settings.patchPluginSettings("demo", { projects: [project + "-missing"] });
        } catch { projectRejected = true; }
        console.log("RESULT:" + JSON.stringify({
          visibleKeys: Object.keys(visible).sort(),
          visiblePrompts: Object.fromEntries(Object.entries(visible).map(([key, value]) => [key, value.prompt])),
          pluginLocal: { key: pluginLocal?.key, prompt: pluginLocal?.prompt },
          normalLocal: { key: normalLocal?.key, prompt: normalLocal?.prompt },
          hidden: { key: hidden?.key, prompt: hidden?.prompt },
          publicProfile,
          globalConfig,
          visiblePages: visiblePages.map((page) => ({ id: page.id, origin: page.origin })),
          before: before.values,
          after: after.values,
          secretRejected,
          projectRejected,
          plugin,
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

      expect(result.visibleKeys).toEqual([
        "plugin:demo/public",
        "plugin:demo/same",
        "project:same",
        "user:same",
      ]);
      expect(result.visiblePrompts["plugin:demo/same"]).toBe("plugin");
      expect(result.visiblePrompts["project:same"]).toBe("project");
      expect(result.visiblePrompts["user:same"]).toBe("user");
      expect(result.pluginLocal).toEqual({ key: "plugin:demo/same", prompt: "plugin" });
      expect(result.normalLocal).toEqual({ key: "project:same", prompt: "project" });
      expect(result.hidden).toEqual({ key: "plugin:demo/private", prompt: "private" });
      expect(result.publicProfile.cwd).toBe(plugin);
      expect(result.publicProfile.additionalDirectories).toContain(plugin);
      const normalizedAdditionalDirectories = result.publicProfile.additionalDirectories
        .map((entry: string) => entry.replace(/\\/g, "/"));
      const normalizedCwdSuggestions = result.publicProfile.cwdSuggestions
        .map((entry: string) => entry.replace(/\\/g, "/"));
      expect(normalizedAdditionalDirectories).toContain(join(plugin, "docs").replace(/\\/g, "/"));
      expect(normalizedCwdSuggestions).toContain(join(plugin, "examples").replace(/\\/g, "/"));
      expect(result.globalConfig.mcpServers.shared.command).toBe("project");
      expect(result.globalConfig.mcpServers.plugin.command).toBe("plugin");
      expect(result.globalConfig.mcpServers.base.command).toBe("base");
      expect(result.globalConfig.providerDefaults.litellm.contextWindow).toBe(128_000);
      expect(result.visiblePages).toEqual([
        { id: "public-page", origin: "plugin" },
        { id: "move-public", origin: "move" },
      ]);
      expect(result.before).toEqual({ hour: 4, open: true, projects: [], secret: "" });
      expect(result.after).toEqual({
        hour: 7,
        open: false,
        projects: [project],
        secret: "ATLAS_TOKEN",
      });
      expect(result.secretRejected).toBe(true);
      expect(result.projectRejected).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
