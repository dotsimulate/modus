import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

test("new and existing sessions deliver all moves and only completed replies become unread", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-moves-replies-"));
  try {
    for (const mode of ["exercise", "persisted", "other-vault"]) {
      const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "moves-and-replies-driver.ts"), mode], {
        cwd: join(import.meta.dir, ".."),
        env: {
          // Test mode selects a per-process DB; these restart checks share an explicitly isolated one.
          ...process.env, NODE_ENV: "development", MODUS_INSTANCE: "default", MODUS_VAULT_ROOT: "",
          MODUS_HOME: join(root, "home"), MODUS_DATA_DIR: join(root, "data"),
          MODUS_CONFIG_DIR: join(root, "config"), MODUS_RUNTIME_DIR: join(root, "runtime"),
          MODUS_LOGS_DIR: join(root, "logs"), MODUS_CACHE_DIR: join(root, "cache"),
          HARNESS_SECRETS_FILE: join(root, "secrets.env"),
          XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"),
          ...(mode === "other-vault" ? {
            MODUS_INSTANCE: "other", MODUS_VAULT_ROOT: join(root, "other-vault"),
            MODUS_DATA_DIR: "", MODUS_RUNTIME_DIR: "", MODUS_LOGS_DIR: "", MODUS_CACHE_DIR: "",
            HARNESS_SECRETS_FILE: join(root, "other-vault", "secrets.env"),
          } : {}),
        },
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, stdout + stderr).toBe(0);
    }
  } finally {
    const childPath = relative(tmpdir(), root);
    if (isAbsolute(childPath) || !childPath.startsWith("modus-moves-replies-") || childPath.includes("..")) throw new Error("Unexpected fixture directory");
    await removeTreeAfterExit(root);
  }
}, 30_000);
