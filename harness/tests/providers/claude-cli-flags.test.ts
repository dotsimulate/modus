import { resolve as resolveTestSourceDir } from "node:path";
/**
 * Claude CLI flags Modus passes are an external contract it does not control.
 * When one is removed upstream the failure is total and silent to every test in
 * this suite: `--no-project-settings` was dropped somewhere before CLI 2.1.215,
 * and because the CLI rejects unknown options outright (`error: unknown option`,
 * exit 1), every `claude-code-pty` session carrying `loadProjectSettings: false`
 * failed to launch at all. Nothing in the harness could see it — the flag is
 * only ever handed to a subprocess.
 *
 * These scan source rather than importing the provider, which pulls
 * session-manager and transitively the database. They cannot verify a flag
 * against the installed CLI (CI has none), so they pin the one removal that has
 * already bitten and the replacement that took its place.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

/** Every module that spawns the `claude` binary directly. */
const CLAUDE_CLI_MODULES = ["claude-code-pty.ts", "claude-cli-oneshot.ts"];

function sourceOf(file: string): string {
  return readFileSync(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), file), "utf-8");
}

describe("claude CLI flags", () => {
  test("no module passes --no-project-settings, removed upstream", () => {
    // The quoted literal, not any mention: a flag only ever reaches the CLI as a
    // string literal, and prose explaining the removal is exactly what should be
    // allowed to name it.
    const offenders = CLAUDE_CLI_MODULES.filter((file) => sourceOf(file).includes(`"--no-project-settings"`));
    expect(offenders).toEqual([]);
  });

  test("the PTY provider disables project settings via --setting-sources", () => {
    // The replacement takes the list of sources to load (user, project, local),
    // so the empty string is what turns settings files and CLAUDE.md discovery
    // off. Verified against CLI 2.1.215: an empty list suppresses a CLAUDE.md
    // the default invocation reads.
    const source = sourceOf("claude-code-pty.ts");
    expect(source).toContain(`args.push("--setting-sources", "")`);
  });
});
