import { resolve } from "node:path";
import { releaseRustEnvironment } from "./rust-path-remap";

type BuildMode = "binary" | "bundle" | "signed";

const mode = process.argv[2] as BuildMode | undefined;
if (!mode || !["binary", "bundle", "signed"].includes(mode)) {
  throw new Error("Usage: bun run build-desktop.ts <binary|bundle|signed>");
}

const tauri = Bun.which("tauri");
if (!tauri) throw new Error("Tauri CLI is not installed; run bun install in desktop/");

const command = [tauri, "build"];
if (mode === "binary") command.push("--no-bundle");
if (mode === "signed") command.push("--config", "src-tauri/tauri.signing.conf.json");

const result = Bun.spawnSync(command, {
  cwd: import.meta.dir,
  env: releaseRustEnvironment({ repositoryDir: resolve(import.meta.dir, "..") }),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) process.exit(result.exitCode);
