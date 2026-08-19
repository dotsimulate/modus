import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";

const repositoryDir = resolvePath(import.meta.dir, "..", "..");
const desktopDir = join(repositoryDir, "desktop");
const tauriDir = join(desktopDir, "src-tauri");

describe("installed Modus CLI packaging", () => {
  test("bundles the CLI and native console launcher as installer artifacts", () => {
    const config = JSON.parse(readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"));
    expect(config.bundle.externalBin).toContain("binaries/bun");
    expect(config.bundle.externalBin).toContain("binaries/modus");

    const staging = readFileSync(join(desktopDir, "stage-managed-backend.ts"), "utf8");
    expect(staging).toContain('bundle(join(harnessDir, "cli.ts"), join(stageDir, "cli.js"))');
    expect(staging).toContain("stageCliLauncher(triple, devMode)");
  });

  test("launcher binds the installed CLI to the packaged backend and resources", () => {
    const launcher = readFileSync(join(desktopDir, "cli-launcher", "src", "main.rs"), "utf8");
    expect(launcher).toContain('.env("MODUS_PACKAGED_CLI", "1")');
    expect(launcher).toContain('.env("MODUS_CLI_SERVER", &layout.server)');
    expect(launcher).toContain('.env("MODUS_RESOURCES_DIR", &layout.resources)');
  });

  test("installer owns one exact user PATH entry across install and uninstall", () => {
    const hooks = readFileSync(join(tauriDir, "nsis-hooks.nsh"), "utf8");
    expect(hooks).toContain("!macro NSIS_HOOK_POSTINSTALL");
    expect(hooks).toContain("--modus-installer-add-user-path");
    expect(hooks).toContain("!macro NSIS_HOOK_PREUNINSTALL");
    expect(hooks).toContain("--modus-installer-remove-user-path");
    expect(hooks).toContain("NSIS_MAX_STRLEN=1024");
    expect(hooks).not.toContain('WriteRegExpandStr HKCU "Environment" "Path"');
  });
});
