import { describe, expect, test } from "bun:test";
import {
  buildProjectDescriptors,
  isWithinProjectRoot,
  resolveSessionProject,
} from "../session-projects";

describe("session project attribution", () => {
  const projects = buildProjectDescriptors({
    modus: { displayName: "Modus", projects: ["C:/work/modus", "C:/work/shared"] },
    nested: { displayName: "Nested", projects: ["C:/work/modus/packages/app"] },
  });

  test("uses path boundaries instead of string prefixes", () => {
    expect(isWithinProjectRoot("C:/work/modus/src", "C:/work/modus")).toBe(true);
    expect(isWithinProjectRoot("C:/work/modus-other", "C:/work/modus")).toBe(false);
    expect(isWithinProjectRoot("c:/work/modus", "C:\\")).toBe(true);
    expect(isWithinProjectRoot("/work/modus", "/")).toBe(true);
  });

  test("keeps explicit project ownership", () => {
    expect(resolveSessionProject({ user_profile: "modus", cwd: "C:/elsewhere" }, projects)).toEqual({
      projectId: "modus",
      projectName: "Modus",
      projectRoot: null,
      explicit: true,
    });
  });

  test("backfills legacy sessions using the most-specific root", () => {
    expect(resolveSessionProject({ cwd: "C:/work/modus/packages/app/src" }, projects)).toEqual({
      projectId: "nested",
      projectName: "Nested",
      projectRoot: "C:/work/modus/packages/app",
      explicit: false,
    });
  });

  test("retains unmatched sessions", () => {
    expect(resolveSessionProject({ cwd: "C:/scratch" }, projects).projectId).toBeNull();
  });
});
