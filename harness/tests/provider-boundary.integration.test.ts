import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolveTestSourceDir } from "node:path";

const SUPERVISOR_CANARY = "provider-boundary-supervisor-canary";
const SESSION_CANARY = "mcp-session-provider-boundary-canary";
const ENV_SESSION_CANARY = "provider-boundary-env-session-canary";
const isolatedRoot = mkdtempSync(join(tmpdir(), "modus-provider-boundary-"));
const workspace = join(isolatedRoot, "workspace");
mkdirSync(workspace, { recursive: true });

function fakeProviderSource(): string {
  return `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const recordPath = process.env.MODUS_TEST_PROVIDER_RECORD;
if (!recordPath) throw new Error("missing fake provider record path");
const args = Bun.argv.slice(2);
const pointedFiles = [];
for (let index = 0; index < args.length; index++) {
  let flag = args[index];
  let path;
  if (flag === "--mcp-config") path = args[++index];
  else if (flag.startsWith("--mcp-config=")) path = flag.slice("--mcp-config=".length);
  if (path && existsSync(path)) {
    pointedFiles.push({ flag: "--mcp-config", path, content: readFileSync(path, "utf8") });
  }
}
const workspaceIndex = args.indexOf("--workspace");
const workspaceArg = workspaceIndex >= 0 ? args[workspaceIndex + 1] : undefined;
const cursorMcpPath = join(workspaceArg || process.cwd(), ".cursor", "mcp.json");
if (existsSync(cursorMcpPath)) {
  pointedFiles.push({ flag: "cwd-discovery", path: cursorMcpPath, content: readFileSync(cursorMcpPath, "utf8") });
}
writeFileSync(recordPath, JSON.stringify({
  pid: process.pid,
  argv: args,
  env: { ...process.env },
  cwd: process.cwd(),
  workspaceArg,
  pointedFiles,
}), "utf8");

let emitted = false;
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk);
  if (!emitted && buffered.includes("\\n")) {
    emitted = true;
    const messages = [
      { type: "system", subtype: "init", session_id: "fake-provider-session", model: "fake-model", tools: [], mcp_servers: [] },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "canned turn" }] } },
      { type: "result", subtype: "success", result: "canned turn", session_id: "fake-provider-session", total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, is_error: false },
    ];
    for (const message of messages) process.stdout.write(JSON.stringify(message) + "\\n");
  }
}
await new Promise(() => {});
`;
}

function writeFakeExecutable(directory: string): string {
  const script = join(directory, "fake-provider.ts");
  writeFileSync(script, fakeProviderSource(), "utf8");
  if (process.platform === "win32") {
    const wrapper = join(directory, "fake-provider.cmd");
    writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, "utf8");
    return wrapper;
  }
  const wrapper = join(directory, "fake-provider");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, "utf8");
  chmodSync(wrapper, 0o700);
  return wrapper;
}

function filteredEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function runBoundary(mode: "claude-code-pty" | "claude-code" | "cursor") {
  const caseRoot = join(isolatedRoot, mode);
  const recordPath = join(caseRoot, "record.json");
  const reportPath = join(caseRoot, "report.json");
  mkdirSync(join(caseRoot, "home"), { recursive: true });
  mkdirSync(join(caseRoot, "config"), { recursive: true });
  const fakeExecutable = writeFakeExecutable(caseRoot);
  const harnessRoot = resolveTestSourceDir(import.meta.dir, "..");
  const child = Bun.spawn([
    process.execPath,
    "run",
    "tests/fixtures/provider-boundary-driver.ts",
  ], {
    cwd: harnessRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...filteredEnvironment(),
      NODE_ENV: "test",
      HOME: join(caseRoot, "home"),
      USERPROFILE: join(caseRoot, "home"),
      AGENT_CWD: workspace,
      CLAUDE_PATH: fakeExecutable,
      CURSOR_AGENT_BIN: fakeExecutable,
      HARNESS_PORT: "0",
      HARNESS_TOKEN: SUPERVISOR_CANARY,
      HARNESS_SECRETS_FILE: join(caseRoot, "config", "secrets.env"),
      MODUS_HOME: join(caseRoot, "home"),
      MODUS_DATA_DIR: join(caseRoot, "data"),
      MODUS_LOGS_DIR: join(caseRoot, "logs"),
      MODUS_RUNTIME_DIR: join(caseRoot, "runtime"),
      MODUS_CACHE_DIR: join(caseRoot, "cache"),
      MODUS_RESOURCES_DIR: harnessRoot,
      MODUS_SESSION_MCP_TOKEN: ENV_SESSION_CANARY,
      MODUS_TEST_PROVIDER_MODE: mode,
      MODUS_TEST_PROVIDER_RECORD: recordPath,
      MODUS_TEST_PROVIDER_REPORT: reportPath,
    },
  });

  const outcome = await Promise.race([
    child.exited.then(code => ({ code, timedOut: false })),
    Bun.sleep(20_000).then(() => ({ code: null, timedOut: true })),
  ]);
  if (outcome.timedOut && child.exitCode === null) child.kill();
  if (child.exitCode === null) await child.exited;
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  if (outcome.timedOut || outcome.code !== 0 || !existsSync(recordPath) || !existsSync(reportPath)) {
    throw new Error(`${mode} boundary driver failed (${outcome.timedOut ? "timeout" : outcome.code}): ${stderr.slice(0, 4_000)}`);
  }
  return {
    logs: `${stdout}\n${stderr}`,
    record: JSON.parse(readFileSync(recordPath, "utf8")) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
      workspaceArg?: string;
      pointedFiles: Array<{ flag: string; path: string; content: string }>;
    },
    report: JSON.parse(readFileSync(reportPath, "utf8")) as {
      spawnPids: number[];
      finalPids: number[];
      fakeAliveAfterDispose: boolean;
      tempExistsBeforeDispose: boolean;
      tempExistsAfterDispose: boolean;
      interruptCalled: boolean;
    },
  };
}

afterAll(() => {
  rmSync(isolatedRoot, { recursive: true, force: true });
});

for (const mode of ["claude-code-pty", "claude-code", "cursor"] as const) {
  describe(`${mode} fake-provider boundary`, () => {
    test("confines credentials, registers its root pid, and cleans up on interrupt/dispose", async () => {
      const { logs, record, report } = await runBoundary(mode);
      const argv = JSON.stringify(record.argv);
      const env = JSON.stringify(record.env);
      const tempContent = record.pointedFiles.map(file => file.content).join("\n");

      expect(record.cwd).toBe(mode === "cursor" ? resolveTestSourceDir(import.meta.dir, "..") : workspace);
      if (mode === "cursor") expect(record.workspaceArg).toBe(workspace);
      expect(record.pointedFiles).toHaveLength(1);
      expect(record.pointedFiles[0]?.flag).toBe(mode === "cursor" ? "cwd-discovery" : "--mcp-config");
      expect(argv).not.toContain(SUPERVISOR_CANARY);
      expect(argv).not.toContain(SESSION_CANARY);
      expect(env).not.toContain(SUPERVISOR_CANARY);
      expect(env).not.toContain(SESSION_CANARY);
      expect(env).not.toContain(ENV_SESSION_CANARY);
      expect(logs).not.toContain(SUPERVISOR_CANARY);
      expect(logs).not.toContain(SESSION_CANARY);
      expect(logs).not.toContain(ENV_SESSION_CANARY);
      expect(tempContent).not.toContain(SUPERVISOR_CANARY);
      expect(tempContent).toContain(SESSION_CANARY);
      expect(report.spawnPids.length).toBeGreaterThan(0);
      expect(report.finalPids).toEqual([]);
      expect(report.fakeAliveAfterDispose).toBe(false);
      expect(report.tempExistsBeforeDispose).toBe(true);
      expect(report.tempExistsAfterDispose).toBe(false);
      expect(report.interruptCalled).toBe(true);
    }, 30_000);
  });
}
