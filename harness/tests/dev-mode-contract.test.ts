import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCommandArguments } from "../cli-arguments";
import { findSourceCheckout, isSourceOnlyCommand } from "../source-checkout";

const root = resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("native development entry point", () => {
  test("the desktop package invokes Tauri and its dev hook owns Vite startup", () => {
    const desktopPackage = JSON.parse(read("desktop/package.json"));
    const tauriConfig = JSON.parse(read("desktop/src-tauri/tauri.conf.json"));
    const stageSource = read("desktop/stage-managed-backend.ts");

    expect(desktopPackage.scripts.dev).toBe("tauri dev");
    expect(tauriConfig.build.beforeDevCommand).toContain("stage-managed-backend.ts --dev");
    expect(tauriConfig.build.devUrl).toBe("http://localhost:5180");
    expect(stageSource).toContain('if (process.argv.includes("--dev"))');
    expect(stageSource).toContain('cwd: join(harnessDir, "ui")');
    expect(stageSource).toContain('Bun.spawn(["bun", "run", "dev"]');
  });

  test("the root CLI defaults to desktop and makes browser mode explicit", () => {
    const cliSource = read("harness/cli.ts");
    const devBody = cliSource.slice(
      cliSource.indexOf("async function cmdDev"),
      cliSource.indexOf("async function cmdLogs"),
    );

    expect(devBody).toContain('const browser = hasFlag(args, "--browser")');
    expect(devBody).toContain("cwd: DESKTOP_DIR");
    expect(devBody.indexOf("if (browser)")).toBeLessThan(devBody.indexOf("cwd: DESKTOP_DIR"));
    expect(devBody).not.toContain("watchdog.ts");
  });

  test("source setup provisions the desktop CLI used by the default", () => {
    const cliSource = read("harness/cli.ts");
    const setupBody = cliSource.slice(
      cliSource.indexOf("function cmdSetup"),
      cliSource.indexOf("async function cmdDev"),
    );

    expect(setupBody).toContain('console.log("\\nInstalling desktop dependencies...")');
    expect(setupBody).toContain("cwd: DESKTOP_DIR");
    expect(setupBody.match(/--frozen-lockfile/g)).toHaveLength(4);
  });

  test("root scripts expose checkout-bound setup and native dev fallbacks", () => {
    const rootPackage = JSON.parse(read("package.json"));
    expect(rootPackage.packageManager).toBe("bun@1.3.12");
    expect(rootPackage.scripts.setup).toBe("bun run harness/cli.ts setup");
    expect(rootPackage.scripts.dev).toBe("bun run harness/cli.ts dev");
    expect(rootPackage.scripts["dev:browser"]).toBe("bun run harness/cli.ts dev --browser");
  });

  test("installed command resolution recognizes source-only commands inside the checkout", () => {
    expect(findSourceCheckout(resolve(root, "desktop", "src-tauri"))).toBe(root);
    expect(findSourceCheckout(resolve(root, ".."))).toBeNull();
    expect(isSourceOnlyCommand("dev")).toBeTrue();
    expect(isSourceOnlyCommand("setup")).toBeTrue();
    expect(isSourceOnlyCommand("update")).toBeTrue();
    expect(isSourceOnlyCommand("start")).toBeFalse();

    const cliSource = read("harness/cli.ts");
    expect(cliSource).toContain("await delegatePackagedSourceCommand()");
    expect(cliSource).toContain("delete environment.MODUS_PACKAGED_CLI");
    expect(cliSource).toContain("delete environment.MODUS_CLI_SERVER");
    expect(cliSource).toContain("delete environment.MODUS_RESOURCES_DIR");
  });

  test("public commands reject arguments they do not understand", () => {
    expect(validateCommandArguments("start", ["dev"], {}))
      .toBe("Unexpected argument for modus start: dev");
    expect(validateCommandArguments("dev", ["--watch"], { flags: ["--browser"] }))
      .toBe("Unknown option for modus dev: --watch");
    expect(validateCommandArguments("start", ["--instance", "work"], {
      valueFlags: ["--instance"],
    })).toBeNull();
  });

  test("legacy browser mode is local-only and the destructive watchdog is retired", () => {
    const browserDev = read("harness/dev.ts");
    const harnessPackage = JSON.parse(read("harness/package.json"));
    expect(browserDev).not.toContain("tailscale");
    expect(harnessPackage.scripts.watch).toBeUndefined();
    expect(harnessPackage.scripts["watch:dev"]).toBeUndefined();
    expect(existsSync(resolve(root, "harness", "watchdog.ts"))).toBeFalse();
  });

  test("each JavaScript package has one canonical Bun lockfile", () => {
    for (const lock of ["bun.lock", "harness/bun.lock", "harness/ui/bun.lock", "desktop/bun.lock"]) {
      expect(existsSync(resolve(root, lock))).toBeTrue();
    }
    expect(existsSync(resolve(root, "harness/ui/package-lock.json"))).toBeFalse();
    expect(existsSync(resolve(root, "desktop/package-lock.json"))).toBeFalse();
  });
});
