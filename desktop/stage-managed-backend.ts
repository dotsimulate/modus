import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { BRIDGED_HARNESS_MODULES } from "../harness/bridged-modules";
import { makeBundlePortable } from "./portable-bundle";
import { desktopBuildProfile } from "./staging-profile";

const desktopDir = import.meta.dir;
const repositoryDir = resolve(desktopDir, "..");
const harnessDir = join(repositoryDir, "harness");
const tauriDir = join(desktopDir, "src-tauri");
const stageDir = join(tauriDir, "resources", "modus");
const binariesDir = join(tauriDir, "binaries");
const targetDir = join(tauriDir, "target");
const cliLauncherDir = join(desktopDir, "cli-launcher");
const cliLauncherTargetDir = join(targetDir, "cli-launcher");

function assertGeneratedPath(target: string, expectedParent: string): void {
  const resolvedTarget = resolve(target);
  const resolvedParent = `${resolve(expectedParent)}${sep}`;
  if (!resolvedTarget.startsWith(resolvedParent)) {
    throw new Error(`Refusing to modify generated path outside ${expectedParent}: ${target}`);
  }
}

function run(command: string[], cwd: string, env?: Record<string, string | undefined>): void {
  const result = Bun.spawnSync(command, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
  }
}

async function bundle(
  input: string,
  output: string,
  portableModuleDirectories: string[] = [],
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [input],
    outdir: resolve(output, ".."),
    naming: basename(output),
    target: "bun",
    minify: false,
    sourcemap: "none",
    // bun-pty is a Windows-only ConPTY binding, loaded solely behind an
    // `if (IS_WINDOWS)` guard in terminal-manager.ts. It has no Linux/macOS
    // build, so keep it external off-Windows — Bun.build must not try to
    // resolve it, and the guarded require never runs at runtime there.
    external: process.platform === "win32" ? [] : ["bun-pty"],
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }
  const portable = makeBundlePortable(
    readFileSync(output, "utf8"),
    portableModuleDirectories,
    [repositoryDir, process.env.USERPROFILE, process.env.HOME],
  );
  writeFileSync(output, portable);
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

/** Path of the ConPTY native library inside the bun-pty package, and the same
 * path the loader probes relative to server.js once staged. */
const PTY_LIBRARY_PATH = join("rust-pty", "target", "release", "rust_pty.dll");

/**
 * Stage bun-pty's native ConPTY library.
 *
 * Bundling inlines bun-pty's JavaScript into server.js, but the Rust library it
 * dlopens cannot be inlined — it is resolved from disk at terminal-create time.
 * The loader probes `<server.js dir>/rust-pty/target/release/` first, which is
 * why the staged layout mirrors the package's own.
 *
 * Nothing copied it before, so a packaged Windows install had working terminals
 * only while an out-of-band copy of the DLL happened to survive in the install
 * directory — and every reinstall wiped it, breaking terminals with
 * "librust_pty shared library not found". No test, typecheck or build can see
 * this: the library is only ever resolved at runtime, on Windows, the first
 * time someone opens a terminal.
 *
 * Missing source throws rather than skipping. A silent skip reproduces the
 * original defect exactly — a green build that ships dead terminals.
 */
function stagePtyLibrary(): void {
  // bun-pty is required only behind an `if (IS_WINDOWS)` guard in
  // terminal-manager.ts; other platforms use Bun.spawn and never load it.
  if (process.platform !== "win32") return;
  const source = join(repositoryDir, "node_modules", "bun-pty", PTY_LIBRARY_PATH);
  if (!existsSync(source)) {
    throw new Error(
      `bun-pty native library missing at ${source}. The packaged terminal cannot work without it; `
      + `check that root dependencies are installed and that bun-pty still ships ${PTY_LIBRARY_PATH}.`,
    );
  }
  const destination = join(stageDir, PTY_LIBRARY_PATH);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
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

function stagePhotonWasm(): void {
  const source = join(
    harnessDir,
    "node_modules",
    "@silvia-odwyer",
    "photon-node",
    "photon_rs_bg.wasm",
  );
  if (!existsSync(source)) {
    throw new Error(
      `Pi image-resize WASM missing at ${source}; packaged image resizing cannot work without it`,
    );
  }
  copyFileSync(source, join(stageDir, "photon_rs_bg.wasm"));
}

/**
 * Copy the Bun runtime the package will ship, and prove which one it is.
 *
 * `Bun.which("bun")` takes whatever is first on the build machine's PATH — in a
 * checkout that has been built once, that can be a Bun from this repository's
 * own `target/` directory. Nothing recorded which version went into a package,
 * so a release record could not name its toolchain versions and the
 * vendored Bun license notice could not be said to describe the shipped binary.
 *
 * The pin is the root `packageManager` field, which already names the Bun this
 * project builds with. A mismatch fails the build rather than shipping a
 * runtime whose notice is wrong.
 */
function stageBunRuntime(destination: string): { version: string; sha256: string } {
  const root = JSON.parse(readFileSync(join(repositoryDir, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  const pinned = /^bun@(\d+\.\d+\.\d+)$/.exec(root.packageManager ?? "")?.[1];
  if (!pinned) {
    throw new Error(`Root package.json must pin "packageManager": "bun@<x.y.z>"; found ${root.packageManager}`);
  }

  const source = process.env.MODUS_DESKTOP_BUN_SOURCE?.trim() || Bun.which("bun");
  if (!source) throw new Error("Could not locate the Bun runtime for desktop packaging");

  const probe = Bun.spawnSync([source, "--version"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    throw new Error(`Could not read the version of the Bun runtime at ${source}: ${probe.stderr.toString()}`);
  }
  const version = probe.stdout.toString().trim();
  if (version !== pinned) {
    throw new Error(
      `The Bun runtime selected for packaging reports ${version}, but this project pins ${pinned}. `
        + "Point MODUS_DESKTOP_BUN_SOURCE at the pinned runtime, or update the pin and re-vendor "
        + "desktop/third-party/bun/LICENSE.md to match.",
    );
  }

  copyFileSync(source, destination);
  const sha256 = new Bun.CryptoHasher("sha256").update(readFileSync(destination)).digest("hex");
  return { version, sha256 };
}

function stageCliLauncher(triple: string, devMode: boolean): string {
  assertGeneratedPath(cliLauncherTargetDir, targetDir);
  const profile = devMode ? "debug" : "release";
  const suffix = process.platform === "win32" ? ".exe" : "";
  const command = [
    "cargo",
    "build",
    "--manifest-path",
    join(cliLauncherDir, "Cargo.toml"),
    "--locked",
    "--target",
    triple,
  ];
  if (!devMode) command.push("--release");
  run(command, cliLauncherDir, { CARGO_TARGET_DIR: cliLauncherTargetDir });

  const source = join(cliLauncherTargetDir, triple, profile, `modus${suffix}`);
  if (!existsSync(source)) {
    throw new Error(`Modus CLI launcher build did not produce ${source}`);
  }
  const destination = join(binariesDir, `modus-${triple}${suffix}`);
  copyFileSync(source, destination);
  return destination;
}

async function stage(): Promise<void> {
  const devMode = process.argv.includes("--dev");
  assertGeneratedPath(stageDir, tauriDir);
  assertGeneratedPath(binariesDir, tauriDir);
  const profile = desktopBuildProfile(devMode);
  const generatedResources = join(targetDir, profile, "modus");
  assertGeneratedPath(generatedResources, targetDir);
  // Tauri overlays resources but does not reliably remove files deleted from
  // the source stage. Clear only the active profile's generated copy so private
  // or obsolete files cannot survive without colliding with a running dev build.
  rmSync(generatedResources, { recursive: true, force: true });
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });
  mkdirSync(binariesDir, { recursive: true });

  run(["bun", "run", "build"], join(harnessDir, "ui"));

  await bundle(
    join(harnessDir, "index.ts"),
    join(stageDir, "server.js"),
    [join(harnessDir, "node_modules", "@silvia-odwyer", "photon-node")],
  );
  await bundle(join(harnessDir, "cli.ts"), join(stageDir, "cli.js"));
  await bundle(join(harnessDir, "action-worker.ts"), join(stageDir, "action-worker.js"));
  await bundle(
    join(harnessDir, "svg-render-worker.ts"),
    join(stageDir, "svg-render-worker.js"),
    [join(harnessDir, "node_modules", "@resvg", "resvg-js")],
  );

  for (const directory of [
    // "actions" is deliberately absent: harness/actions/ is gitignored personal
    // scratch, and copyResourceDirectory has no gitignore awareness, so staging
    // it shipped whatever the build machine happened to have there — including
    // the webhook tokens loadActionsFromDir writes into an authored action.json.
    // Shipped actions are tracked content and live in core-actions/.
    "core-actions",
    "docs",
    "lenses",
    "moves",
    "pages",
    "projections",
    "prompts",
    "templates",
    "ui/dist",
    "ui/extensions",
    "ui/themes",
  ]) {
    copyResourceDirectory(directory);
  }

  stagePtyLibrary();
  stagePhotonWasm();

  // Bridge shims: built-in moves import harness runtime modules by relative
  // path (e.g. `../../docs-registry`). The bundled server.js does not ship
  // those as source, so emit a CJS shim per bridged module that re-exports the
  // live instance server.js publishes on the process global (see
  // harness/harness-bridge.ts). This keeps a dynamically-loaded move's
  // singletons identical to server.js's.
  for (const name of BRIDGED_HARNESS_MODULES) {
    const shimPath = join(stageDir, `${name}.ts`);
    assertGeneratedPath(shimPath, stageDir);
    writeFileSync(
      shimPath,
      `// AUTO-GENERATED by stage-managed-backend.ts — bridges built-in move imports\n` +
        `// to the running server.js instance. See harness/harness-bridge.ts.\n` +
        `module.exports = globalThis.__modusHarness__.get(${JSON.stringify(name)});\n`,
    );
  }

  // harness/profiles is a legacy, machine-owned migration source in checkout
  // mode. Never package it: ignored profile state/history may be private, and
  // installed builds seed clean defaults from templates/profiles instead.
  if (existsSync(join(stageDir, "profiles"))) {
    throw new Error("Legacy checkout profiles must not be included in the desktop package");
  }

  for (const file of ["version.json", "plugin.json", "ABOUT.md"]) {
    const source = join(harnessDir, file);
    if (existsSync(source)) copyFileSync(source, join(stageDir, file));
  }
  copyFileSync(join(desktopDir, "managed-backend-package.json"), join(stageDir, "package.json"));

  // The notices describe the whole package, so they ship with it. They live at
  // the repository root rather than under harness/docs/ because a megabyte of
  // license text does not belong in the searchable documentation set.
  copyFileSync(join(repositoryDir, "THIRD-PARTY-NOTICES.md"), join(stageDir, "THIRD-PARTY-NOTICES.md"));

  const triple = targetTriple();
  const suffix = process.platform === "win32" ? ".exe" : "";
  const bunDestination = join(binariesDir, `bun-${triple}${suffix}`);
  const bun = stageBunRuntime(bunDestination);
  const cliDestination = stageCliLauncher(triple, devMode);
  writeFileSync(
    join(stageDir, "build-inputs.json"),
    `${JSON.stringify({ target: triple, bun }, null, 2)}\n`,
  );

  // Native addons ship per-libc variants (e.g. resvgjs.linux-x64-{gnu,musl}-*.node).
  // Bun.build copies every variant it can see, but only the one matching this
  // build's target libc is ever loaded. Prune the mismatched variant: a stray
  // musl binary breaks linuxdeploy (unresolvable libc.musl-*.so) on a glibc host
  // and is wrong-ABI weight in any package.
  const dropLibc = triple.includes("-musl") ? "gnu" : triple.includes("-gnu") ? "musl" : null;
  if (dropLibc) {
    for (const file of new Bun.Glob(`**/*-${dropLibc}-*.node`).scanSync({ cwd: stageDir, onlyFiles: true })) {
      const nodePath = join(stageDir, file);
      assertGeneratedPath(nodePath, stageDir);
      rmSync(nodePath);
      console.log(`[desktop] pruned non-target (${dropLibc}) native addon ${file}`);
    }
  }

  const stagedBytes = [...new Bun.Glob("**/*").scanSync({ cwd: stageDir, onlyFiles: true })]
    .reduce((total, file) => total + Bun.file(join(stageDir, file)).size, 0);
  console.log(
    `[desktop] staged managed backend + CLI (${(stagedBytes / 1024 / 1024).toFixed(1)} MiB), `
      + `${basename(bunDestination)}, and ${basename(cliDestination)}`,
  );
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
