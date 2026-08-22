import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";

const SOURCE_ONLY_COMMANDS = new Set(["dev", "setup", "update"]);

function packageName(path: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export function isSourceOnlyCommand(command: string): boolean {
  return SOURCE_ONLY_COMMANDS.has(command);
}

/** Find a credible Modus checkout at or above a working directory. */
export function findSourceCheckout(start: string): string | null {
  let candidate = resolve(start);
  while (true) {
    if (
      packageName(join(candidate, "package.json")) === "modus-root"
      && packageName(join(candidate, "harness", "package.json")) === "modus-harness"
      && packageName(join(candidate, "desktop", "package.json")) === "modus-desktop"
      && existsSync(join(candidate, "harness", "cli.ts"))
      && existsSync(join(candidate, "desktop", "src-tauri", "tauri.conf.json"))
    ) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}
