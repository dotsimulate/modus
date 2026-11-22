import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

test("notifyConfigChange preserves existing session config and does not loop back to provider.updateConfig", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-session-cfg-preserve-"));
  try {
    const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "session-config-preserve-driver.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env, NODE_ENV: "development", MODUS_INSTANCE: "default", MODUS_VAULT_ROOT: "",
        MODUS_HOME: join(root, "home"), MODUS_DATA_DIR: join(root, "data"),
        MODUS_CONFIG_DIR: join(root, "config"), MODUS_RUNTIME_DIR: join(root, "runtime"),
        MODUS_LOGS_DIR: join(root, "logs"), MODUS_CACHE_DIR: join(root, "cache"),
        HARNESS_SECRETS_FILE: join(root, "secrets.env"),
        XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"),
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    const childPath = relative(tmpdir(), root);
    if (isAbsolute(childPath) || !childPath.startsWith("modus-session-cfg-preserve-") || childPath.includes("..")) {
      throw new Error("Unexpected fixture directory");
    }
    await removeTreeAfterExit(root);
  }
}, 30_000);
