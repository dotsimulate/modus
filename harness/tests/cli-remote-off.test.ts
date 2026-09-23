import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ownershipFor } from "../tailscale-serve";

const cliPath = resolve(import.meta.dir, "..", "cli.ts");
const fakeTailscale = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MODUS_TEST_CALLS, JSON.stringify(args) + "\\n");
if (args.join(" ") === "serve status --json") {
  if (process.env.MODUS_TEST_SCENARIO === "unreadable") {
    console.error("daemon unavailable");
    process.exit(1);
  }
  if (process.env.MODUS_TEST_SCENARIO === "malformed") {
    console.log("not-json");
    process.exit(0);
  }
  console.log(process.env.MODUS_TEST_SCENARIO === "none" || existsSync(process.env.MODUS_TEST_REMOVED)
    ? "{}" : process.env.MODUS_TEST_SCENARIO === "foreign"
      ? process.env.MODUS_TEST_FOREIGN_CONFIG : process.env.MODUS_TEST_CONFIG);
} else if (args.join(" ") === "serve --https=443 off") {
  if (process.env.MODUS_TEST_SCENARIO === "failed") {
    console.error("simulated failure");
    process.exit(1);
  }
  writeFileSync(process.env.MODUS_TEST_REMOVED, "removed");
} else {
  console.error("unexpected Tailscale args: " + args.join(" "));
  process.exit(2);
}
`;

async function runRemoteOff(scenario: "failed" | "removed" | "none" | "foreign" | "unreadable" | "malformed") {
  const root = mkdtempSync(join(tmpdir(), "modus-remote-off-"));
  const configDir = join(root, "user", ".config", "agent-dev-zone");
  const calls = join(root, "tailscale-calls.jsonl");
  const removedFile = join(root, "removed");
  const fakeSource = join(root, "fake-tailscale.ts");
  const fakeCommand = join(root, process.platform === "win32" ? "tailscale.exe" : "tailscale");
  const owner = ownershipFor("host.example.ts.net", 3777, new Date(0));
  const config = JSON.stringify({
    Web: { [owner.endpoint]: { Handlers: { "/": { Proxy: owner.proxy } } } },
  });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "remote"), "tailscale");
  writeFileSync(join(configDir, "tailscale-serve-owner.json"), JSON.stringify(owner));
  try {
    writeFileSync(fakeSource, fakeTailscale);
    const compiled = Bun.spawnSync([process.execPath, "build", "--compile", fakeSource, "--outfile", fakeCommand], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    if (compiled.exitCode !== 0) throw new Error(`fake Tailscale build failed: ${compiled.stderr.toString()}`);
    // Windows commonly exposes the inherited key as "Path". Adding "PATH" beside
    // it can leave command lookup using the inherited path and a real tailscale.
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    );
    childEnv[process.platform === "win32" ? "Path" : "PATH"] = root;
    const child = Bun.spawn([process.execPath, "run", cliPath, "remote", "off"], {
      cwd: resolve(import.meta.dir, ".."),
      env: {
        ...childEnv,
        HOME: join(root, "user"),
        USERPROFILE: join(root, "user"),
        MODUS_HOME: join(root, "home"),
        MODUS_CONFIG_DIR: join(root, "config"),
        MODUS_DATA_DIR: join(root, "data"),
        MODUS_CACHE_DIR: join(root, "cache"),
        MODUS_RUNTIME_DIR: join(root, "runtime"),
        MODUS_LOGS_DIR: join(root, "logs"),
        HARNESS_SECRETS_FILE: join(root, "secrets.env"),
        XDG_CONFIG_HOME: join(root, "xdg-config"),
        XDG_DATA_HOME: join(root, "xdg-data"),
        XDG_CACHE_HOME: join(root, "xdg-cache"),
        MODUS_TEST_CALLS: calls,
        MODUS_TEST_CONFIG: config,
        MODUS_TEST_FOREIGN_CONFIG: JSON.stringify({
          Web: { [owner.endpoint]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } } },
        }),
        MODUS_TEST_SCENARIO: scenario,
        MODUS_TEST_REMOVED: removedFile,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const output = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const result = await Promise.race([output, Bun.sleep(10_000).then(() => null)]);
    if (!result) {
      child.kill();
      throw new Error("remote off CLI test timed out");
    }
    if (!existsSync(calls)) throw new Error("fake Tailscale was not invoked");
    return {
      exitCode: result[0], stdout: result[1], stderr: result[2],
      calls: readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
      preferenceExists: existsSync(join(configDir, "remote")),
      ownershipExists: existsSync(join(configDir, "tailscale-serve-owner.json")),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("remote off reports a failed Modus-owned Serve removal and exits nonzero", async () => {
  const result = await runRemoteOff("failed");
  expect(result.exitCode).toBe(1);
  expect(result.stdout).not.toContain("Remote access disabled");
  expect(result.stderr).toContain("Modus Tailscale Serve rule is still active");
  expect(result.calls).toContainEqual(["serve", "--https=443", "off"]);
  expect(result.calls).not.toContainEqual(["serve", "reset"]);
  expect(result.preferenceExists).toBe(false);
  expect(result.ownershipExists).toBe(true);
});

test("remote off succeeds when it removes the owned rule or finds no active rule", async () => {
  const removed = await runRemoteOff("removed");
  expect(removed.exitCode).toBe(0);
  expect(removed.stdout).toContain("Removed Tailscale Serve rule");
  expect(removed.calls).toContainEqual(["serve", "--https=443", "off"]);
  expect(removed.ownershipExists).toBe(false);

  const absent = await runRemoteOff("none");
  expect(absent.exitCode).toBe(0);
  expect(absent.stdout).toContain("No Tailscale Serve rule was active");
  expect(absent.calls).not.toContainEqual(["serve", "--https=443", "off"]);
});

test("remote off leaves unrelated Serve rules untouched", async () => {
  const result = await runRemoteOff("foreign");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Existing Tailscale Serve rule was left untouched");
  expect(result.calls).not.toContainEqual(["serve", "--https=443", "off"]);
  expect(result.ownershipExists).toBe(true);
});

test("remote off reports unreadable and malformed Serve state as unverified", async () => {
  for (const scenario of ["unreadable", "malformed"] as const) {
    const result = await runRemoteOff(scenario);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not verify the Tailscale Serve rule");
    expect(result.stdout).not.toContain("Remote access disabled");
  }
});
