/**
 * shutdownAll() reaps provider CLI subprocesses. It used to be sync, firing
 * `dispose?.().catch(() => {})` and returning immediately, while the caller exited on a
 * fixed 500ms timer — so any provider teardown slower than that budget left its
 * subprocess orphaned. On POSIX the orphan is reparented to init and survives, which is
 * the ghost-process failure this project keeps hitting.
 *
 * The fix made shutdownAll() return a capped promise. That only holds while every call
 * site awaits it, and a missed `await` is invisible: no type error (the promise is just
 * discarded), no test failure, no runtime warning. This suite is the guard.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const HARNESS_DIR = import.meta.dir;
const SKIP_DIRS = new Set(["node_modules", "ui", "moves", "templates", "docs", "sdk"]);

function harnessSourceFiles(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ file: full, source: readFileSync(full, "utf-8") });
      }
    }
  };
  walk(HARNESS_DIR);
  return out;
}

describe("shutdown contract", () => {
  test("every shutdownAll() call site awaits it", () => {
    const unawaited: string[] = [];
    for (const { file, source } of harnessSourceFiles()) {
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("shutdownAll()")) return;
        // The declaration itself, and the terminals variant, are not call sites.
        if (line.includes("function shutdownAll")) return;
        if (!/(?<!\w)shutdownAll\(\)/.test(line)) return;
        if (/await\s+shutdownAll\(\)/.test(line)) return;
        unawaited.push(`${file.replace(HARNESS_DIR, "harness")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(unawaited).toEqual([]);
  });

  test("shutdownAll caps how long it waits for provider teardown", () => {
    const source = readFileSync(join(HARNESS_DIR, "session-manager.ts"), "utf-8");
    // An unbounded Promise.all would hang shutdown behind a wedged provider.
    expect(source).toContain("PROVIDER_DISPOSE_TIMEOUT_MS");
    expect(source).toMatch(/Promise\.race\(/);
  });
});

describe("posix teardown reaps the process group", () => {
  const cli = readFileSync(join(HARNESS_DIR, "cli.ts"), "utf-8");

  test("the non-Windows kill path signals a group, not a bare pid", () => {
    // process.kill(-pid) is the only thing that reaches provider CLIs beneath the
    // backend; a bare proc.kill() leaves them orphaned.
    expect(cli).toMatch(/process\.kill\(-pid/);
    expect(cli).not.toMatch(/^\s*proc\.kill\(\);\s*$/m);
  });

  test("a group-killed child is spawned detached so it leads its own group", () => {
    // Signalling -pid when the target is not a group leader either fails or, worse,
    // hits an unrelated group. The foreground backend must be detached for this.
    expect(cli).toMatch(/detached:\s*process\.platform\s*!==\s*"win32"/);
  });
});
