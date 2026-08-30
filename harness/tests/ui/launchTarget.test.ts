/**
 * Launch-target resolution.
 *
 * The rules here are a client-side mirror of `isWithinProjectRoot` /
 * `resolveSessionProject` in harness/session-projects.ts. The parity block at
 * the bottom is the point of this file: if the backend changes how a cwd maps
 * to a project and the launcher does not, a card will say one project and open
 * another, and nothing else in the tree would notice.
 */

import { describe, expect, test } from "bun:test";
import {
  composeDraft,
  isWithinRoot,
  normalizeRoot,
  projectForCwd,
  projectLabel,
  rootFor,
  type ProjectLike,
} from "../../ui/src/launch-target";
import {
  isWithinProjectRoot,
  normalizeProjectPath,
  resolveSessionProject,
  type SessionProjectDescriptor,
} from "../../session-projects";

const MODUS: ProjectLike = { name: "modus", displayName: "Modus", projects: ["D:\\Projects\\app"] };
const NESTED: ProjectLike = { name: "ui-lab", displayName: "UI Lab", projects: ["D:\\Projects\\app\\ui"] };
const OTHER: ProjectLike = { name: "other", projects: ["D:/Projects/other"] };
const ROOTLESS: ProjectLike = { name: "rootless", displayName: "Rootless", projects: [] };

describe("normalizeRoot", () => {
  test("lowercases drive-letter paths and unifies separators", () => {
    expect(normalizeRoot("D:\\Projects\\app")).toBe("d:/projects/app");
    expect(normalizeRoot("D:/Projects/app/")).toBe("d:/projects/app");
  });

  test("leaves posix paths case-sensitive", () => {
    expect(normalizeRoot("/home/user/app")).toBe("/home/user/app");
  });

  test("strips only trailing separators, not the whole path", () => {
    expect(normalizeRoot("  D:\\Projects\\app\\\\  ")).toBe("d:/projects/app");
  });
});

describe("isWithinRoot", () => {
  test("matches the root itself and descendants", () => {
    expect(isWithinRoot("D:\\Projects\\app", "D:/Projects/app")).toBe(true);
    expect(isWithinRoot("D:/Projects/app/harness", "D:\\Projects\\app")).toBe(true);
  });

  test("does not match a sibling that merely shares a prefix", () => {
    expect(isWithinRoot("D:/Projects/app-old", "D:/Projects/app")).toBe(false);
  });

  test("empty inputs never match", () => {
    expect(isWithinRoot("", "D:/Projects/app")).toBe(false);
    expect(isWithinRoot("D:/Projects/app", "")).toBe(false);
  });
});

describe("projectForCwd", () => {
  const projects = [MODUS, NESTED, OTHER];

  test("resolves a folder to its owning project", () => {
    expect(projectForCwd("D:\\Projects\\app\\harness", projects)?.name).toBe("modus");
  });

  test("most-specific root wins so a nested project keeps its own sessions", () => {
    expect(projectForCwd("D:/Projects/app/ui/src", projects)?.name).toBe("ui-lab");
  });

  test("returns null for an unconfigured folder", () => {
    expect(projectForCwd("D:/elsewhere", projects)).toBeNull();
  });

  test("returns null for a missing cwd rather than guessing the first project", () => {
    expect(projectForCwd(null, projects)).toBeNull();
    expect(projectForCwd(undefined, projects)).toBeNull();
    expect(projectForCwd("", projects)).toBeNull();
  });

  test("a project with no configured roots never claims a folder", () => {
    expect(projectForCwd("D:/Projects/app", [ROOTLESS])).toBeNull();
  });
});

describe("projectLabel", () => {
  test("prefers displayName, falls back to id, then to a marker", () => {
    expect(projectLabel(MODUS)).toBe("Modus");
    expect(projectLabel(OTHER)).toBe("other");
    expect(projectLabel(null)).toBe("unconfigured");
  });
});

describe("rootFor", () => {
  const multi: ProjectLike = {
    name: "multi",
    projects: ["D:/Projects/app", "D:/Projects/app/harness"],
  };

  test("picks the longest configured root containing the cwd", () => {
    expect(rootFor(multi, "D:/Projects/app/harness/ui")).toBe("D:/Projects/app/harness");
  });

  test("falls back to the first root when the cwd is outside all of them", () => {
    expect(rootFor(multi, "D:/elsewhere")).toBe("D:/Projects/app");
  });

  test("falls back to the first root when no cwd is supplied", () => {
    expect(rootFor(multi)).toBe("D:/Projects/app");
  });

  test("never invents a path for a project with no roots", () => {
    expect(rootFor(ROOTLESS, "D:/anything")).toBeUndefined();
    expect(rootFor(null)).toBeUndefined();
  });
});

describe("composeDraft", () => {
  test("returns the bare prompt when there are no references", () => {
    expect(composeDraft("  check in on the launcher  ")).toBe("check in on the launcher");
    expect(composeDraft("do the thing", [])).toBe("do the thing");
  });

  test("fences the references below the prompt", () => {
    expect(composeDraft("pick this back up", ["abc-1 · 2026-08-21 · shipped the lens host"]))
      .toBe([
        "pick this back up",
        "",
        "```",
        "recent material",
        "  abc-1 · 2026-08-21 · shipped the lens host",
        "```",
      ].join("\n"));
  });

  test("drops blank reference lines rather than emitting an empty bullet", () => {
    expect(composeDraft("x", ["  ", "a"])).toContain("  a");
    expect(composeDraft("x", ["  ", "a"]).split("\n").filter((l) => l.trim() === "").length).toBe(1);
  });

  test("an empty prompt yields the block alone, not a leading blank line", () => {
    expect(composeDraft("", ["a"]).startsWith("```")).toBe(true);
  });
});

describe("parity with harness/session-projects.ts", () => {
  const cases: Array<[cwd: string, root: string]> = [
    ["D:\\Projects\\app", "D:/Projects/app"],
    ["D:/Projects/app/harness", "D:\\Projects\\app"],
    ["D:/Projects/app-old", "D:/Projects/app"],
    ["D:/PROJECTS/APP/harness", "d:/projects/app"],
    ["/home/user/app/harness", "/home/user/app"],
    ["/home/user/app2", "/home/user/app"],
  ];

  test("normalizeRoot agrees with normalizeProjectPath on absolute paths", () => {
    for (const [cwd] of cases) {
      expect(normalizeRoot(cwd)).toBe(normalizeProjectPath(cwd));
    }
  });

  test("isWithinRoot agrees with isWithinProjectRoot", () => {
    for (const [cwd, root] of cases) {
      expect(isWithinRoot(cwd, root)).toBe(isWithinProjectRoot(cwd, root));
    }
  });

  test("projectForCwd agrees with resolveSessionProject for path-derived ownership", () => {
    const descriptors: SessionProjectDescriptor[] = [MODUS, NESTED, OTHER].map((p) => ({
      id: p.name,
      name: p.displayName ?? p.name,
      roots: p.projects ?? [],
    }));
    const probes = [
      "D:/Projects/app/harness",
      "D:/Projects/app/ui/src",
      "D:\\Projects\\app",
      "D:/Projects/other/thing",
      "D:/elsewhere",
    ];
    for (const cwd of probes) {
      const backend = resolveSessionProject({ cwd }, descriptors).projectId;
      expect(projectForCwd(cwd, [MODUS, NESTED, OTHER])?.name ?? null).toBe(backend);
    }
  });
});
