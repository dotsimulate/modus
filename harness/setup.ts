/**
 * First-time setup — installs all modus dependencies.
 * Run via: modus setup  (modus.bat or modus.sh)
 *
 * Steps:
 *   1. bun install (harness) — already done by the shell script before we get here
 *   2. bun install (harness/ui)
 *   3. uv sync (agent_memory)
 */
import { join, resolve } from "path";
import { existsSync } from "fs";

const ROOT = resolve(import.meta.dir, "..");
const UI_DIR = join(import.meta.dir, "ui");
const AGENT_MEMORY_DIR = join(ROOT, "agent_memory");

function run(cmd: string, args: string[], cwd: string, { warn }: { warn?: boolean } = {}): void {
  console.log(`\n→ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  const result = Bun.spawnSync([cmd, ...args], { cwd, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) {
    if (warn) {
      console.warn(`\nWarning: ${cmd} ${args.join(" ")} failed (exit ${result.exitCode}) — skipping.`);
    } else {
      console.error(`\nFailed: ${cmd} ${args.join(" ")}`);
      process.exit(result.exitCode ?? 1);
    }
  }
}

console.log("Setting up Modus...\n");

// 1. harness deps — already run by shell script, but be explicit
console.log("✓ harness deps (already installed)");

// 2. UI deps
if (!existsSync(UI_DIR)) {
  console.error(`UI directory not found: ${UI_DIR}`);
  process.exit(1);
}
run("bun", ["install"], UI_DIR);

// 3. agent_memory Python deps
if (!existsSync(AGENT_MEMORY_DIR)) {
  console.error(`agent_memory directory not found: ${AGENT_MEMORY_DIR}`);
  process.exit(1);
}
// If .venv already exists and uv sync fails, it's likely a file-lock (process running) — warn only
const venvExists = existsSync(join(AGENT_MEMORY_DIR, ".venv"));
run("uv", ["sync"], AGENT_MEMORY_DIR, { warn: venvExists });

console.log("\nDone. Run `modus` to start, or `modus init` in a project folder.");
