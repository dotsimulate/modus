import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const harnessDir = join(import.meta.dir, "..");

describe("shipped modus-helper profile", () => {
  test("is project-only, brain-backed, and inherits the bypass default", () => {
    const profile = JSON.parse(readFileSync(join(harnessDir, "templates", "profiles", "agents", "modus-helper.json"), "utf8"));
    expect(profile.moves).toEqual([{ name: "modus-brain" }]);
    expect(profile).not.toHaveProperty("skills");
    expect(profile).not.toHaveProperty("permissionPolicy");
    expect(profile.prompt).toContain("project's `.modus/`");
    expect(profile.prompt).not.toContain("<current-home>");
  });

  test("shipped prompt contexts do not direct agents to unreachable slash skills", () => {
    for (const name of ["setup-agents", "configure"]) {
      const context = readFileSync(join(harnessDir, "prompts", name, "context.ts"), "utf8");
      expect(context).not.toMatch(/\/create-(?:profile|action) skill/);
    }
  });
});
