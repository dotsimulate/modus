import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeSkill(path: string, description: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ndescription: ${description}\n---\n\nbody\n`);
}

async function runInIsolatedHome(root: string, script: string) {
  const url = pathToFileURL(join(import.meta.dir, "skill-attachment.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `
    const attach = await import(${JSON.stringify(url)});
    ${script}
  `], {
    env: {
      ...process.env,
      MODUS_HOME: join(root, "home"),
      MODUS_RESOURCES_DIR: join(root, "resources"),
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
  const marker = stdout.indexOf("RESULT:");
  expect(marker, stdout + stderr).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(marker + "RESULT:".length).split("\n")[0]!);
}

describe("collectSkills", () => {
  test("prefers an installed skill over a move-bundled one of the same name", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-attach-precedence-"));
    const project = join(root, "project");
    const moveDir = join(project, ".modus", "moves", "demo");
    writeSkill(join(project, ".modus", "skills", "overlap", "SKILL.md"), "installed copy");
    writeSkill(join(moveDir, "skills", "overlap", "SKILL.md"), "bundled copy");
    writeSkill(join(moveDir, "skills", "bundled-only", "SKILL.md"), "only in the move");

    try {
      const result = await runInIsolatedHome(root, `
        const out = attach.collectSkills(${JSON.stringify(project)}, {
          names: ["overlap"],
          moves: [{ name: "demo", dir: ${JSON.stringify(moveDir)} }],
        });
        console.log("RESULT:" + JSON.stringify({
          names: out.skills.map((s) => [s.name, s.origin, s.description]),
          missing: out.missing,
        }));
      `);
      expect(result.names).toEqual([
        ["bundled-only", "move", "only in the move"],
        ["overlap", "project", "installed copy"],
      ]);
      expect(result.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports unresolvable names instead of failing", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-attach-missing-"));
    const project = join(root, "project");
    writeSkill(join(project, ".modus", "skills", "real", "SKILL.md"), "exists");

    try {
      const result = await runInIsolatedHome(root, `
        const out = attach.collectSkills(${JSON.stringify(project)}, {
          names: ["real", "create-profile", "create-action"],
          moves: [{ name: "demo", dir: ${JSON.stringify(join(project, "nope"))}, skills: ["also-gone"] }],
        });
        console.log("RESULT:" + JSON.stringify({
          names: out.skills.map((s) => s.name),
          missing: out.missing,
        }));
      `);
      // The shipped modus-dev.json ships exactly these two names; a machine
      // without them must still start a session.
      expect(result.names).toEqual(["real"]);
      expect(result.missing).toEqual([
        { name: "create-profile", requestedBy: "profile" },
        { name: "create-action", requestedBy: "profile" },
        { name: "also-gone", requestedBy: 'move "demo"' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attaches installed skills referenced by a move", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-attach-move-ref-"));
    const project = join(root, "project");
    writeSkill(join(root, "home", "skills", "shared-ref", "SKILL.md"), "user-global");

    try {
      const result = await runInIsolatedHome(root, `
        const out = attach.collectSkills(${JSON.stringify(project)}, {
          moves: [{ name: "demo", dir: ${JSON.stringify(join(project, "moves", "demo"))}, skills: ["shared-ref"] }],
        });
        console.log("RESULT:" + JSON.stringify(out.skills.map((s) => [s.name, s.origin])));
      `);
      expect(result).toEqual([["shared-ref", "user"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("session skill scopes", () => {
  test("mints one key per session, amends on later attach, and isolates by key", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-attach-scope-"));
    try {
      const result = await runInIsolatedHome(root, `
        const skill = (name) => ({ name, description: name, dir: "/tmp/" + name, path: "/tmp/" + name + "/SKILL.md", origin: "project", meta: {} });

        const noneKey = attach.attachSessionSkills("empty-session", []);
        const first = attach.attachSessionSkills("s1", [skill("alpha")]);
        const second = attach.attachSessionSkills("s1", [skill("beta")]);
        const other = attach.attachSessionSkills("s2", [skill("gamma")]);

        const beforeRelease = attach.getScopedSkills(first).map((s) => s.name);
        attach.releaseSessionSkills("s1");

        console.log("RESULT:" + JSON.stringify({
          noneKey,
          sameKey: first === second,
          distinctKeys: first !== other,
          prefixed: attach.isSkillScopeKey(first),
          beforeRelease,
          otherScope: attach.getScopedSkills(other).map((s) => s.name),
          crossLookup: attach.getScopedSkill(other, "alpha"),
          afterRelease: attach.getScopedSkills(first),
          unknownKey: attach.getScopedSkills("skl-does-not-exist"),
        }));
      `);
      expect(result.noneKey).toBeNull();
      expect(result.sameKey).toBe(true);
      expect(result.distinctKeys).toBe(true);
      expect(result.prefixed).toBe(true);
      expect(result.beforeRelease).toEqual(["alpha", "beta"]);
      expect(result.otherScope).toEqual(["gamma"]);
      expect(result.crossLookup).toBeNull();
      expect(result.afterRelease).toBeNull();
      expect(result.unknownKey).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
