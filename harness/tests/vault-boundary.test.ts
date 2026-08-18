import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

type BoundaryResult = {
  registeredPlugins: string[];
  enabledPlugins: string[];
  resolvedPlugin: boolean;
  registeredPluginLookup: boolean;
  actions: string[];
  channel: { ok: boolean; error?: string };
  delivered: boolean;
  completionDelivered: boolean;
  eventDelivered: boolean;
};

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runBoundaryScenario(instance: "default" | "denied" | "allowed"): Promise<BoundaryResult> {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-boundary-"));
  const home = join(root, "home");
  const resources = join(root, "resources");
  const plugin = join(root, "plugin");
  const project = join(root, "project");
  const deliveryPath = join(root, "delivered.jsonl");
  const completionPath = join(root, "completion.jsonl");
  const eventPath = join(root, "event.jsonl");

  write(join(home, "plugins.json"), {
    plugins: [{ id: "fixture-plugin", path: plugin, enabled: true }],
  });
  write(join(plugin, ".modus", "plugin.json"), { id: "fixture-plugin", name: "Fixture" });
  write(join(home, "profiles", "users", "operator.json"), {
    displayName: "Operator",
    projects: [project],
  });
  write(join(home, "profiles", "_global.json"), {
    mcpServers: {},
    notificationChannels: {
      sink: { type: "file", path: deliveryPath },
      completion: { type: "file", path: completionPath },
      event: { type: "file", path: eventPath },
    },
  });
  write(join(project, ".modus", "actions", "project-action", "action.json"), {
    name: "project-action",
    enabled: false,
    agentProfile: "modus-dev",
    trigger: { type: "manual" },
    maxRuns: 1,
  });
  if (instance === "allowed") {
    write(join(home, "private", "vault.json"), {
      plugins: { mode: "deny", allow: ["fixture-plugin"] },
      projectAutomation: { mode: "deny", allow: [project] },
      channels: { mode: "deny", allow: ["sink", "completion", "event"] },
    });
  }

  try {
    const harnessDir = resolvePath(import.meta.dir, "..");
    const pluginsUrl = pathToFileURL(join(harnessDir, "modus-plugins.ts")).href;
    const actionsUrl = pathToFileURL(join(harnessDir, "action-runner.ts")).href;
    const notifyUrl = pathToFileURL(join(harnessDir, "notify.ts")).href;
    const script = `
      const { existsSync } = await import("fs");
      const plugins = await import(${JSON.stringify(pluginsUrl)});
      const actions = await import(${JSON.stringify(actionsUrl)});
      const notify = await import(${JSON.stringify(notifyUrl)});
      const registeredPlugins = plugins.listModusPlugins().map((plugin) => plugin.id);
      const enabledPlugins = plugins.listEnabledModusPlugins().map((plugin) => plugin.id);
      const resolvedPlugin = !!plugins.getModusPlugin("fixture-plugin");
      const registeredPluginLookup = !!plugins.getModusPlugin("fixture-plugin", { includeDisabled: true });
      actions.initActions();
      const actionNames = actions.getActions().map((action) => action.name);
      const channel = await notify.sendToNamedChannel("sink", { text: "private" });
      await notify.sendNotifications(
        [{ channel: "completion", on: "success" }],
        { status: "success", error: null, costUsd: 0, durationMs: 1 },
        { actionName: "project-action", runNumber: 1, profile: "modus-dev" },
      );
      await notify.sendActionNotification(
        [{ channel: "event", on: "exhausted" }],
        "exhausted",
        { actionName: "project-action", profile: "modus-dev" },
      );
      actions.stopActions();
      console.log("RESULT:" + JSON.stringify({
        registeredPlugins,
        enabledPlugins,
        resolvedPlugin,
        registeredPluginLookup,
        actions: actionNames,
        channel,
        delivered: existsSync(${JSON.stringify(deliveryPath)}),
        completionDelivered: existsSync(${JSON.stringify(completionPath)}),
        eventDelivered: existsSync(${JSON.stringify(eventPath)}),
      }));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        MODUS_HOME: home,
        MODUS_INSTANCE: instance === "default" ? "" : "private",
        MODUS_RESOURCES_DIR: resources,
        MODUS_DATA_DIR: join(root, "data"),
        MODUS_LOGS_DIR: join(root, "logs"),
        MODUS_RUNTIME_DIR: join(root, "runtime"),
        MODUS_CACHE_DIR: join(root, "cache"),
        HARNESS_SECRETS_FILE: join(root, "secrets.env"),
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
    return JSON.parse(result!.slice("RESULT:".length)) as BoundaryResult;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Vault execution and egress boundaries", () => {
  test("a named Vault with no policy cannot execute shared capabilities", async () => {
    const result = await runBoundaryScenario("denied");
    expect(result.registeredPlugins).toContain("fixture-plugin");
    expect(result.registeredPluginLookup).toBe(true);
    expect(result.enabledPlugins).not.toContain("fixture-plugin");
    expect(result.resolvedPlugin).toBe(false);
    expect(result.actions).not.toContain("project-action");
    expect(result.channel).toEqual({ ok: false, error: 'Channel "sink" is disabled by Vault policy' });
    expect(result.delivered).toBe(false);
    expect(result.completionDelivered).toBe(false);
    expect(result.eventDelivered).toBe(false);
  });

  test("the default Vault preserves existing shared capability behavior", async () => {
    const result = await runBoundaryScenario("default");
    expect(result.enabledPlugins).toContain("fixture-plugin");
    expect(result.resolvedPlugin).toBe(true);
    expect(result.actions).toContain("project-action");
    expect(result.channel).toEqual({ ok: true });
    expect(result.delivered).toBe(true);
    expect(result.completionDelivered).toBe(true);
    expect(result.eventDelivered).toBe(true);
  });

  test("an explicit named policy enables only its selected capabilities", async () => {
    const result = await runBoundaryScenario("allowed");
    expect(result.enabledPlugins).toContain("fixture-plugin");
    expect(result.resolvedPlugin).toBe(true);
    expect(result.actions).toContain("project-action");
    expect(result.channel).toEqual({ ok: true });
    expect(result.delivered).toBe(true);
    expect(result.completionDelivered).toBe(true);
    expect(result.eventDelivered).toBe(true);
  });
});
