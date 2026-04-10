/**
 * First-time setup — installs all modus dependencies.
 * Run via: modus setup
 *
 * Steps:
 *   1. bun install (harness)
 *   2. bun install (harness/ui)
 *   3. bun run build (harness/ui)
 */
import { join } from "path";
import { existsSync } from "fs";

const UI_DIR = join(import.meta.dir, "ui");

function run(cmd: string, args: string[], cwd: string): void {
  console.log(`\n> ${cmd} ${args.join(" ")}  (in ${cwd})`);
  const result = Bun.spawnSync([cmd, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
    process.exit(result.exitCode ?? 1);
  }
}

console.log("Setting up Modus...\n");

// 1. Harness deps
run("bun", ["install"], import.meta.dir);

// 2. UI deps
if (!existsSync(UI_DIR)) {
  console.error(`UI directory not found: ${UI_DIR}`);
  process.exit(1);
}
run("bun", ["install"], UI_DIR);

// 3. Build UI
run("bun", ["run", "build"], UI_DIR);

console.log("\nDone. Run `modus start` to launch, or `modus init` in a project folder.");
