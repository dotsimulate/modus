import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { canonicalVaultRoot, createVault } from "../vault-registry";

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function write(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveReady);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve an IPv4 test port");
  await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
  return address.port;
}

async function runCli(
  cliPath: string,
  harnessDir: string,
  env: Record<string, string>,
  args: string[],
): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, "run", cliPath, ...args], {
    cwd: harnessDir,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const result = await Promise.race([
    output,
    Bun.sleep(30_000).then(() => null),
  ]);
  if (!result) {
    child.kill();
    const ended = await output;
    throw new Error(`CLI command timed out: ${args.join(" ")}\nstdout: ${ended[1]}\nstderr: ${ended[2]}`);
  }
  return { exitCode: result[0], stdout: result[1], stderr: result[2] };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceStopOwnedTree(pid: number): void {
  if (!processAlive(pid)) return;
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}

describe("named Vault CLI lifecycle", () => {
  test("starts, reports, logs, and stops two registered arbitrary roots without Main state", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "modus-cli-vault-lifecycle-"));
    const harnessDir = resolve(import.meta.dir, "..");
    const cliPath = join(harnessDir, "cli.ts");
    const mainHome = join(fixture, "main");
    const userHome = join(fixture, "user-home");
    const project = join(fixture, "project");
    const roots = [
      { slug: "alpha", root: join(fixture, "portable", "alpha-root"), port: await freePort() },
      { slug: "beta", root: join(fixture, "elsewhere", "deep", "beta-root"), port: await freePort() },
    ];
    mkdirSync(project, { recursive: true });
    for (const item of roots) {
      createVault({ slug: item.slug, root: item.root, mode: "initialize" }, { modusHome: mainHome }, 100);
      write(join(item.root, "secrets.env"), `BOUNDARY_SECRET=${item.slug}\n`);
      write(join(item.root, "profiles", "agents", `${item.slug}-only.json`), `{"prompt":"${item.slug}"}\n`);
    }
    write(join(mainHome, "main-canary.txt"), "main\n");
    const registryPath = join(mainHome, "vaults.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { vaults: unknown[] };
    registry.vaults.push({ slug: "legacy", name: "Legacy", createdAt: 50, autostart: true });
    write(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const registryBefore = readFileSync(registryPath, "utf8");

    const inherited = { ...process.env } as Record<string, string | undefined>;
    for (const key of [
      "AGENT_CWD",
      "HARNESS_SECRETS_FILE",
      "HARNESS_TOKEN",
      "MODUS_CACHE_DIR",
      "MODUS_CONFIG_DIR",
      "MODUS_DATA_DIR",
      "MODUS_DESKTOP_MANAGED",
      "MODUS_DESKTOP_READY_FILE",
      "MODUS_HOME",
      "MODUS_INSTANCE",
      "MODUS_LOGS_DIR",
      "MODUS_PACKAGED_CLI",
      "MODUS_RESOURCES_DIR",
      "MODUS_RUNTIME_DIR",
      "MODUS_VAULT_ROOT",
    ]) delete inherited[key];
    const baseEnv = Object.fromEntries(Object.entries({
      ...inherited,
      AGENT_CWD: project,
      HARNESS_HOST: "127.0.0.1",
      HOME: userHome,
      MODUS_CLI_NO_OPEN_BROWSER: "1",
      MODUS_HOME: mainHome,
      NODE_ENV: "production",
      USERPROFILE: userHome,
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));

    const startedPids = new Map<string, number>();
    try {
      const unknown = await runCli(
        cliPath,
        harnessDir,
        { ...baseEnv, HARNESS_PORT: String(roots[0]!.port) },
        ["status", "--instance", "unknown"],
      );
      expect(unknown.exitCode).toBe(1);
      expect(unknown.stderr).toContain("not registered");
      const legacy = await runCli(
        cliPath,
        harnessDir,
        { ...baseEnv, HARNESS_PORT: String(roots[0]!.port) },
        ["status", "--instance", "legacy"],
      );
      expect(legacy.exitCode).toBe(1);
      expect(legacy.stderr).toContain("repair");

      for (const item of roots) {
        const env = { ...baseEnv, HARNESS_PORT: String(item.port) };
        const started = await runCli(cliPath, harnessDir, env, ["start", "-d", "--instance", item.slug]);
        expect(started.exitCode, started.stderr).toBe(0);
        const runtime = join(item.root, "runtime");
        const pid = Number(readFileSync(join(runtime, "harness.pid"), "utf8"));
        startedPids.set(item.slug, pid);
        expect(processAlive(pid)).toBe(true);
        expect(readFileSync(join(runtime, "harness.port"), "utf8")).toBe(String(item.port));
        expect(existsSync(join(runtime, "harness-token"))).toBe(true);
        expect(existsSync(join(item.root, "logs", "harness.log"))).toBe(true);

        const status = await runCli(cliPath, harnessDir, env, ["status", "--instance", item.slug]);
        expect(status.exitCode, status.stderr).toBe(0);
        expect(normalize(status.stdout).toLowerCase()).toContain(normalize(canonicalVaultRoot(item.root)).toLowerCase());
        const logs = await runCli(cliPath, harnessDir, env, ["logs", "--instance", item.slug]);
        expect(logs.exitCode, logs.stderr).toBe(0);
      }

      expect(readFileSync(join(roots[0]!.root, "runtime", "harness-token"), "utf8"))
        .not.toBe(readFileSync(join(roots[1]!.root, "runtime", "harness-token"), "utf8"));
      expect(existsSync(join(mainHome, "alpha"))).toBe(false);
      expect(existsSync(join(mainHome, "beta"))).toBe(false);
      expect(readFileSync(join(mainHome, "main-canary.txt"), "utf8")).toBe("main\n");
      expect(readFileSync(registryPath, "utf8")).toBe(registryBefore);

      for (const item of roots) {
        const stopped = await runCli(
          cliPath,
          harnessDir,
          { ...baseEnv, HARNESS_PORT: String(item.port) },
          ["stop", "--instance", item.slug],
        );
        expect(stopped.exitCode, stopped.stderr).toBe(0);
        expect(existsSync(join(item.root, "runtime", "harness.pid"))).toBe(false);
        expect(existsSync(join(item.root, "runtime", "harness.port"))).toBe(false);
      }
    } finally {
      for (const item of roots) {
        try {
          await runCli(
            cliPath,
            harnessDir,
            { ...baseEnv, HARNESS_PORT: String(item.port) },
            ["stop", "--instance", item.slug],
          );
        } catch { /* fallback below handles an interrupted lifecycle */ }
        const pid = startedPids.get(item.slug);
        if (pid) forceStopOwnedTree(pid);
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 75_000);
});
