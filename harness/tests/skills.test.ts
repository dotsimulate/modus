import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeSkill(path: string, frontmatter: string, body = "body text\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\n${frontmatter}\n---\n\n${body}`);
}

/** Run assertions inside an isolated MODUS_HOME — skills.ts resolves the home
 *  tier through APP_PATHS, which is captured at import time. */
async function runInIsolatedHome(root: string, script: string) {
  const skillsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "skills.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `
    const skills = await import(${JSON.stringify(skillsUrl)});
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

describe("skill front-matter", () => {
  test("reads a folded block scalar whose continuation lines contain colons", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-fm-"));
    const project = join(root, "project");
    // Mirrors the shipped templates/skills/create-move/SKILL.md shape: a `>`
    // folded description whose last line ends in "Trigger on:". A flat
    // `key: value` parser turns that line into a bogus key and truncates.
    writeSkill(
      join(project, ".modus", "skills", "folded", "SKILL.md"),
      [
        "name: folded",
        "description: >",
        "  First line of the description.",
        "  Each move lives in .modus/moves/name/ with move.json. Trigger on:",
        '  "create a move", "new move".',
        "allowed-tools: Read, Write",
      ].join("\n"),
    );

    try {
      const result = await runInIsolatedHome(root, `
        const skill = skills.getInstalledSkill("folded", ${JSON.stringify(project)});
        console.log("RESULT:" + JSON.stringify(skill));
      `);
      expect(result.description).toBe(
        'First line of the description. Each move lives in .modus/moves/name/ with move.json. Trigger on: "create a move", "new move".',
      );
      expect(result.meta["Trigger on"]).toBeUndefined();
      expect(result.meta["allowed-tools"]).toBe("Read, Write");
      expect(result.name).toBe("folded");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("takes the directory name as canonical, not the front-matter name", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-name-"));
    const project = join(root, "project");
    writeSkill(
      join(project, ".modus", "skills", "on-disk", "SKILL.md"),
      "name: something-else\ndescription: mismatched name",
    );

    try {
      const result = await runInIsolatedHome(root, `
        const skill = skills.getInstalledSkill("on-disk", ${JSON.stringify(project)});
        console.log("RESULT:" + JSON.stringify(skill));
      `);
      expect(result.name).toBe("on-disk");
      expect(result.description).toBe("mismatched name");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("skill discovery", () => {
  test("resolves project over user over plugin, and lists each name once", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-precedence-"));
    const project = join(root, "project");
    const pluginPath = join(root, "plugin");

    writeSkill(join(project, ".modus", "skills", "shared", "SKILL.md"), "description: from project");
    writeSkill(join(root, "home", "skills", "shared", "SKILL.md"), "description: from user");
    writeSkill(join(pluginPath, ".modus", "skills", "shared", "SKILL.md"), "description: from plugin");
    writeSkill(join(root, "home", "skills", "user-only", "SKILL.md"), "description: only in home");
    writeSkill(join(pluginPath, ".modus", "skills", "plugin-only", "SKILL.md"), "description: only in plugin");

    mkdirSync(join(root, "home"), { recursive: true });
    writeFileSync(
      join(root, "home", "plugins.json"),
      JSON.stringify({ plugins: [{ id: "demo", path: pluginPath, enabled: true }] }),
    );

    try {
      const result = await runInIsolatedHome(root, `
        const cwd = ${JSON.stringify(project)};
        console.log("RESULT:" + JSON.stringify({
          winner: skills.getInstalledSkill("shared", cwd),
          all: skills.listInstalledSkills(cwd).map((s) => [s.name, s.origin, s.description]),
        }));
      `);
      expect(result.winner.origin).toBe("project");
      expect(result.winner.description).toBe("from project");
      expect(result.all).toEqual([
        ["plugin-only", "plugin", "only in plugin"],
        ["shared", "project", "from project"],
        ["user-only", "user", "only in home"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores a directory with no SKILL.md and never scans provider skill dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-empty-"));
    const project = join(root, "project");
    mkdirSync(join(project, ".modus", "skills", "no-manifest"), { recursive: true });
    writeSkill(join(project, ".claude", "skills", "native", "SKILL.md"), "description: native claude skill");
    writeSkill(join(project, ".modus", "skills", "real", "SKILL.md"), "description: a real one");

    try {
      const result = await runInIsolatedHome(root, `
        const cwd = ${JSON.stringify(project)};
        console.log("RESULT:" + JSON.stringify({
          all: skills.listInstalledSkills(cwd).map((s) => s.name),
          native: skills.getInstalledSkill("native", cwd),
        }));
      `);
      expect(result.all).toEqual(["real"]);
      expect(result.native).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("finds move-bundled skills without installing them", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-move-"));
    const project = join(root, "project");
    const moveDir = join(project, ".modus", "moves", "demo");
    writeSkill(join(moveDir, "skills", "bundled", "SKILL.md"), "description: ships with the move");

    try {
      const result = await runInIsolatedHome(root, `
        const cwd = ${JSON.stringify(project)};
        console.log("RESULT:" + JSON.stringify({
          bundled: skills.listMoveSkills(${JSON.stringify(moveDir)}, "demo"),
          installed: skills.listInstalledSkills(cwd).map((s) => s.name),
        }));
      `);
      expect(result.bundled).toHaveLength(1);
      expect(result.bundled[0].name).toBe("bundled");
      expect(result.bundled[0].origin).toBe("move");
      expect(result.bundled[0].moveName).toBe("demo");
      expect(result.installed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The activation payload is an interoperability contract, not a local style
 * choice: https://agentskills.io/specification defines progressive disclosure
 * and tells authors to reference bundled files relative to the skill root, and
 * Claude Code emits `Base Path: <dir>` with frontmatter stripped. A skill
 * written for either harness has to behave the same here.
 */
describe("skill activation payload", () => {
  test("strips frontmatter and leads with the base path", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-payload-"));
    const project = join(root, "project");
    const dir = join(project, ".modus", "skills", "demo");
    writeSkill(
      join(dir, "SKILL.md"),
      "name: demo\ndescription: >\n  Does a thing. Use when: asked.",
      "# Demo\n\nSee references/REFERENCE.md for details.\n",
    );

    try {
      const result = await runInIsolatedHome(root, `
        const skill = skills.getInstalledSkill("demo", ${JSON.stringify(project)});
        console.log("RESULT:" + JSON.stringify({ payload: skills.buildSkillPayload(skill) }));
      `);
      const payload: string = result.payload;
      // Base path first, so relative references resolve.
      expect(payload.startsWith(`Base Path: ${dir}`)).toBe(true);
      // Body preserved.
      expect(payload).toContain("# Demo");
      expect(payload).toContain("See references/REFERENCE.md for details.");
      // Frontmatter gone — including the selection-time "Use when:" phrasing,
      // which reads as a contradictory instruction once the skill is loaded.
      expect(payload).not.toContain("---");
      expect(payload).not.toContain("description:");
      expect(payload).not.toContain("Use when:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("substitutes the skill-dir placeholders imported skills rely on", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-vars-"));
    const project = join(root, "project");
    const dir = join(project, ".modus", "skills", "vars");
    writeSkill(
      join(dir, "SKILL.md"),
      "name: vars\ndescription: placeholder test",
      "Run ${CLAUDE_SKILL_DIR}/scripts/go.py and read ${SKILL_DIR}/notes.md\n",
    );

    try {
      const result = await runInIsolatedHome(root, `
        const skill = skills.getInstalledSkill("vars", ${JSON.stringify(project)});
        console.log("RESULT:" + JSON.stringify({ payload: skills.buildSkillPayload(skill) }));
      `);
      const payload: string = result.payload;
      expect(payload).toContain(`${dir}/scripts/go.py`);
      expect(payload).toContain(`${dir}/notes.md`);
      expect(payload).not.toContain("CLAUDE_SKILL_DIR");
      expect(payload).not.toContain("${SKILL_DIR}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("returns null for a skill whose file cannot be read", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-skills-missing-"));
    const project = join(root, "project");
    const dir = join(project, ".modus", "skills", "gone");
    writeSkill(join(dir, "SKILL.md"), "name: gone\ndescription: removed later");

    try {
      const result = await runInIsolatedHome(root, `
        const fs = require("fs");
        const skill = skills.getInstalledSkill("gone", ${JSON.stringify(project)});
        fs.rmSync(skill.path);
        console.log("RESULT:" + JSON.stringify({ payload: skills.buildSkillPayload(skill) }));
      `);
      expect(result.payload).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
