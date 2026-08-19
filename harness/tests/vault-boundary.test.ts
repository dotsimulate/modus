import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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
  revokedActions: string[];
  revokedProjectTrigger: boolean | null;
  revokedPluginTrigger: boolean | null;
  revokedSessionExecutions: number | null;
  mainPluginVisible: boolean;
  mainConfigUnchanged: boolean;
};

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runBoundaryScenario(instance: "default" | "denied" | "allowed"): Promise<BoundaryResult> {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-boundary-"));
  const home = join(root, "home");
  const vaultHome = join(root, "chosen-vault");
  const selectedHome = instance === "default" ? home : vaultHome;
  const resources = join(root, "resources");
  const plugin = join(root, "plugin");
  const project = join(root, "project");
  const deliveryPath = join(root, "delivered.jsonl");
  const completionPath = join(root, "completion.jsonl");
  const eventPath = join(root, "event.jsonl");

  write(join(selectedHome, "plugins.json"), {
    plugins: [{ id: "fixture-plugin", path: plugin, enabled: true }],
  });
  if (instance !== "default") {
    const mainPlugin = join(root, "main-only-plugin");
    write(join(home, "plugins.json"), {
      plugins: [{ id: "main-only-plugin", path: mainPlugin, enabled: true }],
    });
    write(join(mainPlugin, ".modus", "plugin.json"), { id: "main-only-plugin", name: "Main only" });
  }
  write(join(plugin, ".modus", "plugin.json"), { id: "fixture-plugin", name: "Fixture" });
  write(join(plugin, ".modus", "actions", "plugin-action", "action.json"), {
    name: "plugin-action",
    enabled: false,
    agentProfile: "modus-dev",
    trigger: { type: "manual" },
    maxRuns: 1,
  });
  write(join(selectedHome, "profiles", "users", "operator.json"), {
    displayName: "Operator",
    projects: [project],
  });
  write(join(selectedHome, "profiles", "_global.json"), {
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
  write(join(project, ".modus", "actions", "session-action", "action.json"), {
    name: "session-action",
    enabled: true,
    agentProfile: "modus-dev",
    trigger: { type: "session", on: "archived" },
    maxRuns: 1,
  });
  write(join(project, ".modus", "actions", "session-action", "context.ts"), `
    export async function gather() {
      return { prompt: "fixture" };
    }
  `);
  if (instance === "allowed") {
    write(join(selectedHome, "vault.json"), {
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
      const { existsSync, writeFileSync } = await import("fs");
      const plugins = await import(${JSON.stringify(pluginsUrl)});
      const actions = await import(${JSON.stringify(actionsUrl)});
      const notify = await import(${JSON.stringify(notifyUrl)});
      const registeredPlugins = plugins.listModusPlugins().map((plugin) => plugin.id);
      const enabledPlugins = plugins.listEnabledModusPlugins().map((plugin) => plugin.id);
      const resolvedPlugin = !!plugins.getModusPlugin("fixture-plugin");
      const registeredPluginLookup = !!plugins.getModusPlugin("fixture-plugin", { includeDisabled: true });
      const mainPluginVisible = !!plugins.getModusPlugin("main-only-plugin", { includeDisabled: true });
      actions.initActions();
      const actionNames = actions.getActions().map((action) => action.name);
      const sessionActionState = actions.getActionState("session-action");
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
      let revokedActions = [];
      let revokedProjectTrigger = null;
      let revokedPluginTrigger = null;
      let revokedSessionExecutions = null;
      if (${JSON.stringify(instance)} === "allowed") {
        writeFileSync(${JSON.stringify(join(selectedHome, "vault.json"))}, JSON.stringify({
          plugins: { mode: "deny", allow: [] },
          projectAutomation: { mode: "deny", allow: [] },
          channels: { mode: "deny", allow: [] },
        }));
        revokedActions = actions.getActions().map((action) => action.name);
        revokedProjectTrigger = await actions.triggerAction("project-action");
        revokedPluginTrigger = await actions.triggerAction("plugin-action");
        actions.onSessionEvent("archived", {
          id: "session-fixture",
          tags: [],
          preview: "fixture",
          messageCount: 1,
        });
        revokedSessionExecutions = sessionActionState.activeExecutions.size;
      }
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
        revokedActions,
        revokedProjectTrigger,
        revokedPluginTrigger,
        revokedSessionExecutions,
        mainPluginVisible,
      }));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        MODUS_HOME: home,
        MODUS_INSTANCE: instance === "default" ? "" : "private",
        MODUS_VAULT_ROOT: instance === "default" ? "" : vaultHome,
        MODUS_RESOURCES_DIR: resources,
        MODUS_DATA_DIR: join(selectedHome, "data"),
        MODUS_LOGS_DIR: join(selectedHome, "logs"),
        MODUS_RUNTIME_DIR: join(selectedHome, "runtime"),
        MODUS_CACHE_DIR: join(selectedHome, "cache"),
        HARNESS_SECRETS_FILE: join(selectedHome, "secrets.env"),
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
    const parsed = JSON.parse(result!.slice("RESULT:".length)) as Omit<BoundaryResult, "mainConfigUnchanged">;
    const expectedMain = instance === "default"
      ? { plugins: [{ id: "fixture-plugin", path: plugin, enabled: true }] }
      : { plugins: [{ id: "main-only-plugin", path: join(root, "main-only-plugin"), enabled: true }] };
    return {
      ...parsed,
      mainConfigUnchanged: readFileSync(join(home, "plugins.json"), "utf8")
        === `${JSON.stringify(expectedMain, null, 2)}\n`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Vault execution and egress boundaries", () => {
  test("a named Vault with no policy cannot execute its registered capabilities", async () => {
    const result = await runBoundaryScenario("denied");
    expect(result.registeredPlugins).toContain("fixture-plugin");
    expect(result.mainPluginVisible).toBe(false);
    expect(result.mainConfigUnchanged).toBe(true);
    expect(result.registeredPluginLookup).toBe(true);
    expect(result.enabledPlugins).not.toContain("fixture-plugin");
    expect(result.resolvedPlugin).toBe(false);
    expect(result.actions).not.toContain("project-action");
    expect(result.actions).not.toContain("plugin-action");
    expect(result.actions).not.toContain("session-action");
    expect(result.channel).toEqual({ ok: false, error: 'Channel "sink" is disabled by Vault policy' });
    expect(result.delivered).toBe(false);
    expect(result.completionDelivered).toBe(false);
    expect(result.eventDelivered).toBe(false);
  }, 15_000);

  test("Main preserves its existing capability behavior", async () => {
    const result = await runBoundaryScenario("default");
    expect(result.enabledPlugins).toContain("fixture-plugin");
    expect(result.mainPluginVisible).toBe(false);
    expect(result.mainConfigUnchanged).toBe(true);
    expect(result.resolvedPlugin).toBe(true);
    expect(result.actions).toContain("project-action");
    expect(result.actions).toContain("plugin-action");
    expect(result.actions).toContain("session-action");
    expect(result.channel).toEqual({ ok: true });
    expect(result.delivered).toBe(true);
    expect(result.completionDelivered).toBe(true);
    expect(result.eventDelivered).toBe(true);
  }, 15_000);

  test("an explicit named policy enables only its selected capabilities", async () => {
    const result = await runBoundaryScenario("allowed");
    expect(result.enabledPlugins).toContain("fixture-plugin");
    expect(result.mainPluginVisible).toBe(false);
    expect(result.mainConfigUnchanged).toBe(true);
    expect(result.resolvedPlugin).toBe(true);
    expect(result.actions).toContain("project-action");
    expect(result.actions).toContain("plugin-action");
    expect(result.actions).toContain("session-action");
    expect(result.channel).toEqual({ ok: true });
    expect(result.delivered).toBe(true);
    expect(result.completionDelivered).toBe(true);
    expect(result.eventDelivered).toBe(true);
    expect(result.revokedActions).not.toContain("project-action");
    expect(result.revokedActions).not.toContain("plugin-action");
    expect(result.revokedProjectTrigger).toBe(false);
    expect(result.revokedPluginTrigger).toBe(false);
    expect(result.revokedSessionExecutions).toBe(0);
  }, 15_000);
});
