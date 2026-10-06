import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { cursorEnvironment, fetchCursorModels, parseCursorModels } from "../../providers/cursor-runtime";

describe("Cursor model discovery", () => {
  test("preserves all account models through indentation, CRLF, and terminal colors", () => {
    expect(parseCursorModels([
      "Available models",
      "  \x1b[32mauto\x1b[0m - Auto",
      "composer-2-fast - Composer 2 Fast",
      "  account-model[effort=high] - Account model (current)",
      "auto - Auto (duplicate)",
      "Use --model to select a model",
    ].join("\r\n"))).toEqual([
      { id: "auto", owned_by: "cursor" },
      { id: "composer-2-fast", owned_by: "cursor" },
      { id: "account-model[effort=high]", owned_by: "cursor" },
    ]);
  });

  test("uses the configured key ahead of inherited credentials without forwarding Modus credentials", () => {
    const env = cursorEnvironment("configured-key", {
      CURSOR_API_KEY: "inherited-key",
      CURSOR_AUTH_TOKEN: "cursor-login-token",
      HARNESS_TOKEN: "supervisor-canary",
      HARNESS_SECRETS_FILE: "private-secrets-file",
      PATH: "provider-path",
    });
    expect(env.CURSOR_API_KEY).toBe("configured-key");
    expect(env.CURSOR_AUTH_TOKEN).toBe("cursor-login-token");
    expect(env.PATH).toBe("provider-path");
    expect(env.HARNESS_TOKEN).toBeUndefined();
    expect(env.HARNESS_SECRETS_FILE).toBeUndefined();
  });

  test("returns discovered models instead of the three static suggestions", async () => {
    expect(await fetchCursorModels(async (_bin, env) => {
      expect(env.HARNESS_TOKEN).toBeUndefined();
      return "new-account-model - New account model";
    })).toEqual([{ id: "new-account-model", owned_by: "cursor" }]);
  });

  test.skipIf(process.platform !== "win32")("discovers models through a Windows shim with the file-managed key", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-cursor-models-"));
    try {
      const fixture = join(root, "cli.ts");
      const shim = join(root, "cursor-agent.cmd");
      const secrets = join(root, "secrets.env");
      writeFileSync(secrets, "CURSOR_API_KEY=file-managed-canary\n");
      writeFileSync(fixture, `
        if (process.argv[2] !== "models" || process.env.CURSOR_API_KEY !== "file-managed-canary"
            || process.env.HARNESS_TOKEN || process.env.HARNESS_SECRETS_FILE) process.exit(1);
        console.log("account-model - Account model");
      `);
      writeFileSync(shim, `@echo off\r\n@"${process.execPath}" "${fixture}" %*\r\n`);
      const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(path).href);
      const child = Bun.spawn([process.execPath, "--eval", `
        import { loadSecrets } from ${moduleUrl(join(import.meta.dir, "../../secrets.ts"))};
        import { fetchProviderModels } from ${moduleUrl(join(import.meta.dir, "../../providers/models.ts"))};
        loadSecrets();
        const models = await fetchProviderModels("cursor");
        if (JSON.stringify(models) !== JSON.stringify([{id:"account-model",owned_by:"cursor"}])) process.exit(1);
      `], {
        env: {
          ...process.env,
          MODUS_INSTANCE: "",
          MODUS_VAULT_ROOT: "",
          MODUS_HOME: root,
          MODUS_DATA_DIR: join(root, "data"),
          MODUS_RUNTIME_DIR: join(root, "runtime"),
          MODUS_LOGS_DIR: join(root, "logs"),
          MODUS_CACHE_DIR: join(root, "cache"),
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"),
          HARNESS_SECRETS_FILE: secrets,
          HARNESS_TOKEN: "supervisor-canary",
          CURSOR_API_KEY: "inherited-canary",
          CURSOR_AGENT_BIN: shim,
          MODUS_PROVIDER_ENV_PASSTHROUGH: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("surfaces login guidance and omits raw credential-bearing diagnostics", async () => {
    await expect(fetchCursorModels(async () => {
      throw { stderr: "Authentication required. sensitive-canary", status: 1 };
    })).rejects.toThrow("Cursor sign-in required. Run cursor-agent login");
    try {
      await fetchCursorModels(async () => { throw { stderr: "sensitive-canary", status: 1 }; });
      throw new Error("Expected discovery to fail");
    } catch (error: any) {
      expect(error.message).toBe("Cursor model discovery failed. Check cursor-agent models in a terminal.");
      expect(error.message).not.toContain("sensitive-canary");
    }
  });

  test("reports missing executable, timeout, and unparseable output without stale models", async () => {
    await expect(fetchCursorModels(async () => { throw { code: "ENOENT" }; })).rejects.toThrow("Cursor CLI not found");
    await expect(fetchCursorModels(async () => { throw { killed: true }; })).rejects.toThrow("timed out");
    await expect(fetchCursorModels(async () => "unexpected output")).rejects.toThrow("no model suggestions");
  });
});
