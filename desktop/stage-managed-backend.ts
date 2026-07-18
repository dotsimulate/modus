import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

const desktopDir = import.meta.dir;
const repositoryDir = resolve(desktopDir, "..");
const harnessDir = join(repositoryDir, "harness");
const tauriDir = join(desktopDir, "src-tauri");
const stageDir = join(tauriDir, "resources", "modus");
const binariesDir = join(tauriDir, "binaries");
const targetDir = join(tauriDir, "target");

function assertGeneratedPath(target: string, expectedParent: string): void {
  const resolvedTarget = resolve(target);
  const resolvedParent = `${resolve(expectedParent)}${sep}`;
  if (!resolvedTarget.startsWith(resolvedParent)) {
    throw new Error(`Refusing to modify generated path outside ${expectedParent}: ${target}`);
  }
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

async function bundle(input: string, output: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [input],
    outdir: resolve(output, ".."),
    naming: basename(output),
    target: "bun",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
}

function copyResourceDirectory(name: string): void {
  const source = join(harnessDir, name);
  if (!existsSync(source)) return;
  const destination = join(stageDir, name);
  cpSync(source, destination, {
    recursive: true,
    filter(path) {
      const rel = relative(source, path);
      const segments = rel.split(/[\\/]/);
      return !segments.some((segment) => [
        "node_modules",
        ".modus",
        "dist-new",
        "__test_artifacts__",
      ].includes(segment));
    },
  });
}

function targetTriple(): string {
  const configured = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (configured) return configured;
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc";
  if (process.platform === "win32" && process.arch === "arm64") return "aarch64-pc-windows-msvc";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`Unsupported desktop target ${process.platform}/${process.arch}`);
}

async function stage(): Promise<void> {
  assertGeneratedPath(stageDir, tauriDir);
  assertGeneratedPath(binariesDir, tauriDir);
  for (const profile of ["debug", "release"]) {
    const generatedResources = join(targetDir, profile, "modus");
    assertGeneratedPath(generatedResources, targetDir);
    // Tauri overlays resources but does not reliably remove files deleted from
    // the source stage. Clear only its generated resource copy so private or
    // obsolete files cannot survive from an earlier build.
    rmSync(generatedResources, { recursive: true, force: true });
  }
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  run(["bun", "run", "build"], join(harnessDir, "ui"));

  await bundle(join(harnessDir, "index.ts"), join(stageDir, "server.js"));
  await bundle(join(harnessDir, "svg-render-worker.ts"), join(stageDir, "svg-render-worker.js"));
  await bundle(join(harnessDir, "providers", "antigravity-hook.ts"), join(stageDir, "providers", "antigravity-hook.js"));
  await bundle(join(harnessDir, "providers", "antigravity-mcp-bridge.ts"), join(stageDir, "providers", "antigravity-mcp-bridge.js"));

  for (const directory of [
    "actions",
    "moves",
    "pages",
    "prompts",
    "templates",
    "ui/dist",
    "ui/extensions",
    "ui/themes",
  ]) {
    copyResourceDirectory(directory);
  }

  // harness/profiles is a legacy, machine-owned migration source in checkout
  // mode. Never package it: ignored profile state/history may be private, and
  // installed builds seed clean defaults from templates/profiles instead.
  if (existsSync(join(stageDir, "profiles"))) {
    throw new Error("Legacy checkout profiles must not be included in the desktop package");
  }

  for (const file of ["version.json"]) {
    const source = join(harnessDir, file);
    if (existsSync(source)) copyFileSync(source, join(stageDir, file));
  }
  copyFileSync(join(desktopDir, "managed-backend-package.json"), join(stageDir, "package.json"));

  const bunSource = process.env.MODUS_DESKTOP_BUN_SOURCE?.trim() || Bun.which("bun");
  if (!bunSource) throw new Error("Could not locate the Bun runtime for desktop packaging");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const bunDestination = join(binariesDir, `bun-${targetTriple()}${suffix}`);
  copyFileSync(bunSource, bunDestination);

  const stagedBytes = [...new Bun.Glob("**/*").scanSync({ cwd: stageDir, onlyFiles: true })]
    .reduce((total, file) => total + Bun.file(join(stageDir, file)).size, 0);
  console.log(`[desktop] staged managed backend (${(stagedBytes / 1024 / 1024).toFixed(1)} MiB) and ${basename(bunDestination)}`);
}

await stage();

if (process.argv.includes("--dev")) {
  const child = Bun.spawn(["bun", "run", "dev"], {
    cwd: join(harnessDir, "ui"),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
}
