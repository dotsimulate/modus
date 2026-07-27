import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeSkill(path: string, description: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ndescription: ${description}\n---\n\n${body}`);
}

/** Drive the MCP handler in a child so the harness DB and home stay isolated. */
async function callMcp(root: string, script: string) {
  const mcpUrl = pathToFileURL(join(import.meta.dir, "modus-mcp.ts")).href;
  const attachUrl = pathToFileURL(join(import.meta.dir, "skill-attachment.ts")).href;
  const piUrl = pathToFileURL(join(import.meta.dir, "providers", "pi-agent.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `
    const mcp = await import(${JSON.stringify(mcpUrl)});
    const attach = await import(${JSON.stringify(attachUrl)});
    const pi = () => import(${JSON.stringify(piUrl)});
    const rpc = async (scopeKey, body) => {
      const res = await mcp.handleModusMcpRequest(new Request("http://127.0.0.1/api/mcp/modus" + (scopeKey ? "/" + scopeKey : ""), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      }), scopeKey);
      return JSON.parse(await res.text());
    };
    ${script}
    process.exit(0);
  `], {
    env: {
      ...process.env,
      MODUS_HOME: join(root, "home"),
      MODUS_RESOURCES_DIR: join(root, "resources"),
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
  const marker = stdout.indexOf("RESULT:");
  expect(marker, stdout + stderr).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(marker + "RESULT:".length).split("\n")[0]!);
}

describe("skill tools on the Modus MCP endpoint", () => {
  test("registers skill tools only for a scope that has skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skill-mcp-tools-"));
    const project = join(root, "project");
    writeSkill(join(project, ".modus", "skills", "alpha", "SKILL.md"), "the alpha skill", "alpha body\n");

    try {
      const result = await callMcp(root, `
        const collected = attach.collectSkills(${JSON.stringify(project)}, { names: ["alpha"] });
        const key = attach.createSkillScope(collected.skills);
        const emptyKey = attach.createSkillScope([]);

        const withSkills = await rpc(key, { method: "tools/list" });
        const plain = await rpc(undefined, { method: "tools/list" });
        const unknown = await rpc("skl-not-a-real-key", { method: "tools/list" });

        const names = (r) => r.result.tools.map((t) => t.name).sort();
        console.log("RESULT:" + JSON.stringify({
          emptyKey,
          scoped: names(withSkills),
          plain: names(plain),
          unknown: names(unknown),
        }));
      `);
      expect(result.emptyKey).toBeNull();
      expect(result.scoped).toEqual(["modus_submit", "skills_list", "skills_load"]);
      expect(result.plain).toEqual(["modus_submit"]);
      expect(result.unknown).toEqual(["modus_submit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // Booting the MCP handler pulls the move runner and the database; the 5s
    // default is not enough for a cold child.
  }, 30_000);

  test("lists descriptions only, and loads full text with its base directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skill-mcp-load-"));
    const project = join(root, "project");
    const skillDir = join(project, ".modus", "skills", "alpha");
    writeSkill(join(skillDir, "SKILL.md"), "the alpha skill", "# Alpha\n\nSee references/deep.md\n");

    try {
      const result = await callMcp(root, `
        const collected = attach.collectSkills(${JSON.stringify(project)}, { names: ["alpha"] });
        const key = attach.createSkillScope(collected.skills);

        const listed = await rpc(key, { method: "tools/call", params: { name: "skills_list", arguments: {} } });
        const loaded = await rpc(key, { method: "tools/call", params: { name: "skills_load", arguments: { name: "alpha" } } });
        const missing = await rpc(key, { method: "tools/call", params: { name: "skills_load", arguments: { name: "nope" } } });

        console.log("RESULT:" + JSON.stringify({
          listed: listed.result.content[0].text,
          loaded: loaded.result.content[0].text,
          missingIsError: missing.result.isError === true,
          missingText: missing.result.content[0].text,
        }));
      `);
      expect(JSON.parse(result.listed)).toEqual([{ name: "alpha", description: "the alpha skill" }]);
      // Discovery is cheap: the list carries no body text.
      expect(result.listed).not.toContain("See references");
      expect(result.loaded).toContain("# Alpha");
      expect(result.loaded).toContain("See references/deep.md");
      expect(result.loaded).toContain(skillDir);
      expect(result.missingIsError).toBe(true);
      expect(result.missingText).toContain("Available: alpha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("PI native skill delivery", () => {
  test("passes attached SKILL.md files individually, not the whole install root", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skill-pi-"));
    const project = join(root, "project");
    const attachedDir = join(project, ".modus", "skills", "attached");
    writeSkill(join(attachedDir, "SKILL.md"), "attached one", "body\n");
    // Installed but never attached — must not reach PI.
    writeSkill(join(project, ".modus", "skills", "dormant", "SKILL.md"), "not attached", "body\n");
    // The user's own Claude skills stay a root, walked by PI unfiltered.
    writeSkill(join(project, ".claude", "skills", "native", "SKILL.md"), "native one", "body\n");

    try {
      const result = await callMcp(root, `
        const { piAdditionalSkillPaths } = await pi();
        const collected = attach.collectSkills(${JSON.stringify(project)}, { names: ["attached"] });
        const key = attach.createSkillScope(collected.skills);
        console.log("RESULT:" + JSON.stringify({
          withSkills: piAdditionalSkillPaths(${JSON.stringify(project)}, key),
          withoutSkills: piAdditionalSkillPaths(${JSON.stringify(project)}),
        }));
      `);
      expect(result.withSkills).toEqual([
        join(project, ".claude", "skills"),
        join(attachedDir, "SKILL.md"),
      ]);
      // Native root first: PI keeps the first path on a name collision, so a
      // user's own skill always wins over an attached one.
      expect(result.withSkills[0]).toContain(".claude");
      expect(result.withSkills.join("|")).not.toContain("dormant");
      expect(result.withoutSkills).toEqual([join(project, ".claude", "skills")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
