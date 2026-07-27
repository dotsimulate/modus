import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

describe("automation profile validation", () => {
  test("warns, audits, and records a missing plugin action profile without starting a session", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-automation-profile-"));
    const home = join(root, "home");
    const resources = join(root, "resources");
    const plugin = join(root, "plugin");
    write(join(resources, "plugin.json"), JSON.stringify({
      id: "modus-core",
      integration: { agentProfiles: [] },
    }));
    write(join(home, "plugins.json"), JSON.stringify({
      plugins: [{ id: "automation-test", path: plugin, enabled: true }],
    }));
    write(join(plugin, ".modus", "plugin.json"), JSON.stringify({
      id: "automation-test",
      integration: { agentProfiles: [] },
    }));
    write(join(plugin, ".modus", "actions", "missing-profile", "action.json"), JSON.stringify({
      name: "missing-profile",
      enabled: false,
      agentProfile: "does-not-exist",
      trigger: { type: "manual" },
      maxRuns: 1,
    }));
    write(
      join(plugin, ".modus", "actions", "missing-profile", "context.ts"),
      `export async function gather() { throw new Error("intentional stop after profile validation"); }\n`,
    );

    try {
      const homeUrl = pathToFileURL(join(import.meta.dir, "modus-home.ts")).href;
      const actionsUrl = pathToFileURL(join(import.meta.dir, "action-runner.ts")).href;
      const dbUrl = pathToFileURL(join(import.meta.dir, "db.ts")).href;
      const activityUrl = pathToFileURL(join(import.meta.dir, "activity.ts")).href;
      const actionPath = join(plugin, ".modus", "actions", "missing-profile", "action.json");
      const script = `
        const home = await import(${JSON.stringify(homeUrl)});
        home.ensureHomeLayout();
        const actions = await import(${JSON.stringify(actionsUrl)});
        const db = await import(${JSON.stringify(dbUrl)});
        const activity = await import(${JSON.stringify(activityUrl)});
        actions.initActions();
        actions.setActionPreference("missing-profile", "skipResetConfirm", true);
        actions.setActionEnabled("missing-profile", true);
        const runtimeCwd = actions.getActionState("missing-profile")?.config.cwd;
        const persisted = await Bun.file(${JSON.stringify(actionPath)}).json();
        const triggered = await actions.triggerAction("missing-profile");
        let run;
        for (let i = 0; i < 100; i++) {
          run = db.getActionRuns("missing-profile", 1)[0];
          if (run?.warning) break;
          await Bun.sleep(10);
        }
        const audit = activity.getActivityLog({
          eventType: "automation_profile_missing",
          limit: 10,
        });
        actions.stopActions();
        console.log("RESULT:" + JSON.stringify({ triggered, run, audit, runtimeCwd, persisted }));
        process.exit(0);
      `;
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {
          ...process.env,
          MODUS_HOME: home,
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
      expect(result.triggered).toBe(true);
      expect(result.run.warning).toContain('missing agent profile "does-not-exist"');
      expect(result.audit).toHaveLength(1);
      expect(result.audit[0].agent_profile).toBe("does-not-exist");
      expect(result.runtimeCwd).toBe(plugin);
      expect(result.persisted.preferences.skipResetConfirm).toBe(true);
      expect(result.persisted).not.toHaveProperty("cwd");
      expect(result.persisted).not.toHaveProperty("origin");
      expect(result.persisted).not.toHaveProperty("pluginId");
      expect(result.persisted).not.toHaveProperty("pluginPath");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
