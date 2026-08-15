import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  legacyMoveRegistryPath,
  legacyMoveStatePath,
  listRuntimeMoveNames,
  moveRegistryPath,
  moveStatePath,
  readablePath,
  readMoveRuntimeIndex,
  updateMoveRuntimeIndex,
} from "../move-runtime-root";

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "modus-runtime-root-"));
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

describe("move runtime root", () => {
  test("runtime paths stay out of the publishable move directory", () => {
    const cwd = join(tmpdir(), "project");
    const registry = moveRegistryPath(cwd, "demo");
    const state = moveStatePath(cwd, "demo", "inst-1");

    for (const path of [registry, state]) {
      const relative = path.slice(cwd.length).replace(/\\/g, "/");
      expect(relative).toStartWith("/.modus/runtime/moves/demo/");
      expect(relative).not.toContain("/.modus/moves/");
    }
  });

  test("reads prefer the runtime root and fall back to the legacy location", () => {
    const cwd = tempProject();
    try {
      const runtime = moveRegistryPath(cwd, "demo");
      const legacy = legacyMoveRegistryPath(cwd, "demo");

      // Nothing on disk: name the location we write, not the one we abandoned.
      expect(readablePath(runtime, legacy)).toBe(runtime);

      write(legacy, "{}");
      expect(readablePath(runtime, legacy)).toBe(legacy);

      write(runtime, "{}");
      expect(readablePath(runtime, legacy)).toBe(runtime);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("the index tracks which moves hold registrations", () => {
    const cwd = tempProject();
    try {
      expect(readMoveRuntimeIndex(cwd)).toEqual([]);

      updateMoveRuntimeIndex(cwd, "beta", true);
      updateMoveRuntimeIndex(cwd, "alpha", true);
      expect(readMoveRuntimeIndex(cwd)).toEqual(["alpha", "beta"]);

      // Idempotent: re-adding a known move must not rewrite the file.
      const path = join(cwd, ".modus", "runtime", "moves", "index.json");
      const before = readFileSync(path, "utf-8");
      updateMoveRuntimeIndex(cwd, "alpha", true);
      expect(readFileSync(path, "utf-8")).toBe(before);

      updateMoveRuntimeIndex(cwd, "alpha", false);
      expect(readMoveRuntimeIndex(cwd)).toEqual(["beta"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("a project with an index needs no move-directory enumeration", () => {
    const cwd = tempProject();
    try {
      updateMoveRuntimeIndex(cwd, "registered", true);
      expect(existsSync(join(cwd, ".modus", "moves"))).toBe(false);
      expect(listRuntimeMoveNames(cwd)).toEqual(["registered"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("legacy move directories are still discovered until their files are gone", () => {
    const cwd = tempProject();
    try {
      updateMoveRuntimeIndex(cwd, "registered", true);
      write(legacyMoveRegistryPath(cwd, "ancient"), "{}");

      expect(listRuntimeMoveNames(cwd).sort()).toEqual(["ancient", "registered"]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("state paths follow the same split", () => {
    const cwd = tempProject();
    try {
      const runtime = moveStatePath(cwd, "demo", "inst-1");
      const legacy = legacyMoveStatePath(cwd, "demo", "inst-1");
      expect(runtime).not.toBe(legacy);

      write(legacy, JSON.stringify({ from: "legacy" }));
      expect(JSON.parse(readFileSync(readablePath(runtime, legacy), "utf-8"))).toEqual({ from: "legacy" });

      write(runtime, JSON.stringify({ from: "runtime" }));
      expect(JSON.parse(readFileSync(readablePath(runtime, legacy), "utf-8"))).toEqual({ from: "runtime" });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The defect this whole change exists to prevent: a runtime writer pointed at
  // an authored move directory, contained only by a hand-maintained .gitignore
  // line. One module is allowed to know that layout, and only to read it.
  test("only the runtime-root module knows the legacy in-move layout", () => {
    const harnessDir = join(import.meta.dir, "..");
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "tests" || entry.name === "ui") continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (entry.name === "move-runtime-root.ts") continue;
        if (readFileSync(path, "utf-8").includes("_registry.json")) {
          offenders.push(path.slice(harnessDir.length + 1).replace(/\\/g, "/"));
        }
      }
    };
    walk(harnessDir);

    expect(offenders).toEqual([]);
  });
});
