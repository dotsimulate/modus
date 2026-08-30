import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { pathToFileURL } from "url";

/**
 * The core tier is synthesized rather than registered, so it has no plugins.json
 * row to hold Vault-scoped values. These run in a subprocess against an isolated
 * MODUS_HOME because APP_PATHS is resolved once at module load from the
 * environment — there is no in-process way to point it somewhere safe.
 */

const harnessDir = resolvePath(import.meta.dir, "..");

async function runInIsolatedHome(root: string, body: string): Promise<string> {
  const settingsUrl = pathToFileURL(join(harnessDir, "plugin-settings.ts")).href;
  const script = `
    const settings = await import(${JSON.stringify(settingsUrl)});
    ${body}
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      MODUS_HOME: root,
      MODUS_INSTANCE: "",
      MODUS_VAULT_ROOT: "",
      // The shipped manifest is the thing under test, so resources point at the
      // real harness/ tree. Nothing here writes to it.
      MODUS_RESOURCES_DIR: harnessDir,
      MODUS_DATA_DIR: join(root, "data"),
      MODUS_LOGS_DIR: join(root, "logs"),
      MODUS_RUNTIME_DIR: join(root, "runtime"),
      MODUS_CACHE_DIR: join(root, "cache"),
      // MODUS_HOME alone is not isolation: the secrets loader defaults outside
      // that tree and would pick up the developer's real PIN.
      HARNESS_SECRETS_FILE: join(root, "secrets.json"),
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
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
  const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith("RESULT:"));
  expect(line, `${stdout}\n${stderr}`).toBeDefined();
  return line!.slice("RESULT:".length);
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "modus-core-settings-"));
}

describe("modus-core settings", () => {
  test("global values round-trip into the Vault's own _global.json", async () => {
    const root = tempHome();
    try {
      const raw = await runInIsolatedHome(root, `
        settings.patchPluginSettings("modus-core", { titleProvider: "openrouter" }, {});
        const snapshot = settings.getPluginSettings("modus-core", {});
        console.log("RESULT:" + JSON.stringify(snapshot.values));
      `);
      expect(JSON.parse(raw).titleProvider).toBe("openrouter");

      // Storage location is part of the contract: per-Vault, not per-install.
      const stored = JSON.parse(readFileSync(join(root, "profiles", "_global.json"), "utf-8")) as {
        pluginSettings?: Record<string, Record<string, unknown>>;
      };
      expect(stored.pluginSettings?.["modus-core"]?.titleProvider).toBe("openrouter");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("a provider that cannot answer a one-shot is rejected at the write, not at run time", async () => {
    const root = tempHome();
    try {
      const raw = await runInIsolatedHome(root, `
        let message = "no error";
        try {
          settings.patchPluginSettings("modus-core", { titleProvider: "codex" }, {});
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        console.log("RESULT:" + JSON.stringify(message));
      `);
      const message = JSON.parse(raw) as string;
      expect(message).toContain("one-shot completion");
      expect(message).toContain("codex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("an unknown provider name is rejected", async () => {
    const root = tempHome();
    try {
      const raw = await runInIsolatedHome(root, `
        let message = "no error";
        try {
          settings.patchPluginSettings("modus-core", { titleProvider: "not-a-provider" }, {});
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        console.log("RESULT:" + JSON.stringify(message));
      `);
      expect(JSON.parse(raw)).toContain("not a known provider");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("the shipped manifest declares the settings auto-title reads", () => {
    const manifest = JSON.parse(readFileSync(join(harnessDir, "plugin.json"), "utf-8")) as {
      settings?: Array<{ key: string; type: string; scope?: string; providerSetting?: string }>;
    };
    const byKey = new Map((manifest.settings ?? []).map((setting) => [setting.key, setting]));

    // The action references these by name in its provider/model fields; a
    // rename on either side silently stops resolving.
    const action = JSON.parse(
      readFileSync(join(harnessDir, "core-actions", "auto-title", "action.json"), "utf-8"),
    ) as { provider?: string; model?: string };
    expect(action.provider).toBe("${settings.titleProvider}");
    expect(action.model).toBe("${settings.titleModel}");

    expect(byKey.get("titleProvider")?.type).toBe("provider");
    expect(byKey.get("titleModel")?.type).toBe("model");
    // Vault-wide, not per user profile: the harness consumes these, so a client
    // that never opened the settings form must still resolve them.
    expect(byKey.get("titleProvider")?.scope).toBe("global");
    expect(byKey.get("titleModel")?.scope).toBe("global");
    expect(byKey.get("titleModel")?.providerSetting).toBe("titleProvider");
  });
});
