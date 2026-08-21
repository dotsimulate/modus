import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function writeJson(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

describe("shared MCP resolution", () => {
  test("discovers every compatibility path and applies one provider-independent order", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-mcp-config-"));
    const project = join(root, "project");
    const home = join(root, "home");
    try {
      writeJson(join(project, ".claude", "mcp.json"), { mcpServers: { compat: { command: "compat" }, same: { command: "compat" } } });
      writeJson(join(project, ".mcp.json"), { mcpServers: { root: { command: "root" }, same: { command: "root" } } });
      writeJson(join(project, ".modus", "mcp.json"), { mcpServers: { modusFile: { command: "modus-file" }, same: { command: "modus-file" } } });
      writeJson(join(project, "shared-mcp.json"), { mcpServers: { globalFile: { command: "global-file" }, same: { command: "global-file" } } });
      writeJson(join(project, ".modus", "_global.json"), { mcpConfig: "../shared-mcp.json", mcpServers: { globalInline: { command: "global-inline" }, same: { command: "global-inline" } } });
      writeJson(join(project, "profile-mcp.json"), { mcpServers: { profileFile: { command: "profile-file" }, same: { command: "profile-file" } } });
      writeJson(join(project, ".modus", "profiles", "agents", "p.json"), {
        description: "p",
        prompt: "p",
        mcpConfig: "../../../profile-mcp.json",
        mcpServers: { profileInline: { command: "profile-inline" }, same: { command: "profile-inline" } },
      });

      const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "mcp-config-driver.ts"), project], {
        env: {
          ...process.env,
          MODUS_HOME: home,
          HARNESS_SECRETS_FILE: join(root, "secrets.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(code, stderr).toBe(0);
      const resolved = JSON.parse(stdout);
      expect(Object.keys(resolved.servers)).toEqual(expect.arrayContaining([
        "compat", "root", "modusFile", "globalFile", "globalInline",
        "profileFile", "profileInline", "sessionOnly", "same", "modus",
      ]));
      expect(resolved.servers.same.command).toBe("session");
      expect(resolved.origins.same).toBe("session");
      expect(resolved.origins.compat).toContain(".claude");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
