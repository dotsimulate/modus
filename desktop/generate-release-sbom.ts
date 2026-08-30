/**
 * Release-time SBOM: the committed dependency graph plus what this build
 * actually produced.
 *
 * Two SBOMs exist on purpose and they answer different questions.
 * `sbom.cdx.json` at the repository root is committed and drift-checked, so it
 * describes the dependency graph of a *source tree* — it deliberately carries
 * no timestamp or serial number, because a value that changes every run cannot
 * be drift-checked. It therefore cannot describe a specific artifact.
 *
 * This one can. It stamps the build, records the source commit and toolchain
 * versions, and attaches a SHA-256 for every file that ships. RELEASES.md
 * requires exactly that ("record the source commit, toolchain versions,
 * dependency locks, artifact size, and SHA-256 digest") and it is the only form
 * that supports "independent checksum and signature verification after upload".
 *
 * Run after a bundle build, from `desktop/`:
 *
 *     bun run release:sbom                 # the canonical NSIS installer
 *     bun run release:sbom path/to/x.exe   # explicit artifacts
 *
 * Output lands in `src-tauri/target/release/sbom-release.cdx.json`, which is a
 * build product, not a tracked file.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";

const desktopDir = import.meta.dir;
const repositoryDir = resolve(desktopDir, "..");
const releaseDir = join(desktopDir, "src-tauri", "target", "release");

function sha256(path: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** Fails rather than reporting "unknown": provenance nobody can trust is worse than none. */
function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repositoryDir, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function toolVersion(command: string[]): string {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed`);
  return result.stdout.toString().trim().split("\n")[0]!.trim();
}

/**
 * Artifacts to hash. The NSIS bundle directory accumulates hand-renamed builds
 * from earlier qualification runs, so nothing is globbed: this build's output
 * is the canonical Tauri filename, and anything else has to be named explicitly.
 */
function defaultArtifacts(version: string): string[] {
  return [
    join(releaseDir, "bundle", "nsis", `Modus_${version}_x64-setup.exe`),
    join(releaseDir, "modus-desktop.exe"),
    join(desktopDir, "src-tauri", "binaries", "modus-x86_64-pc-windows-msvc.exe"),
    join(desktopDir, "src-tauri", "binaries", "bun-x86_64-pc-windows-msvc.exe"),
  ];
}

function main(): void {
  const { version } = JSON.parse(readFileSync(join(repositoryDir, "harness", "version.json"), "utf-8")) as {
    version: string;
  };

  const explicit = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const artifacts = explicit.length > 0 ? explicit.map((path) => resolve(path)) : defaultArtifacts(version);
  const missing = artifacts.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `Cannot describe a build that did not produce these:\n  ${missing.join("\n  ")}\n`
        + "Run `bun run build:bundle` first, or pass artifact paths explicitly.",
    );
  }

  // The staged record of which Bun runtime went into the package. Staging
  // writes it and refuses to proceed when the runtime does not match the pin.
  const buildInputsPath = join(releaseDir, "modus", "build-inputs.json");
  if (!existsSync(buildInputsPath)) {
    throw new Error(`No staged build record at ${buildInputsPath}; stage the backend before describing the build`);
  }
  const buildInputs = JSON.parse(readFileSync(buildInputsPath, "utf-8")) as {
    target: string;
    bun: { version: string; sha256: string };
  };

  const base = JSON.parse(readFileSync(join(repositoryDir, "sbom.cdx.json"), "utf-8")) as {
    metadata: { component: Record<string, unknown>; properties: { name: string; value: string }[] };
    components: unknown[];
  };

  const dirty = git("status", "--porcelain") !== "";
  const document = {
    ...base,
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    metadata: {
      timestamp: new Date().toISOString(),
      ...base.metadata,
      component: {
        ...base.metadata.component,
        hashes: artifacts.map((path) => ({ alg: "SHA-256", content: sha256(path) })),
      },
      properties: [
        ...base.metadata.properties,
        { name: "modus:sourceCommit", value: git("rev-parse", "HEAD") },
        { name: "modus:sourceClean", value: String(!dirty) },
        { name: "modus:buildTarget", value: buildInputs.target },
        { name: "modus:bunVersion", value: buildInputs.bun.version },
        { name: "modus:bunSha256", value: buildInputs.bun.sha256 },
        { name: "modus:rustc", value: toolVersion(["rustc", "--version"]) },
        { name: "modus:tauriCli", value: toolVersion(["bun", "x", "tauri", "--version"]) },
      ],
    },
    components: [
      ...artifacts.map((path) => ({
        type: "file",
        "bom-ref": `artifact:${basename(path)}`,
        name: basename(path),
        version,
        hashes: [{ alg: "SHA-256", content: sha256(path) }],
        properties: [{ name: "modus:sizeBytes", value: String(statSync(path).size) }],
      })),
      ...base.components,
    ],
  };

  const output = join(releaseDir, "sbom-release.cdx.json");
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf-8");

  console.log(`wrote ${output}`);
  if (dirty) console.warn("WARNING: the source tree is dirty; this build is not reproducible from a commit");
  for (const path of artifacts) {
    console.log(`  ${sha256(path)}  ${(statSync(path).size / 1048576).toFixed(1)} MiB  ${basename(path)}`);
  }
}

main();
