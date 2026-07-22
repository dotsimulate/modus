import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ReadinessRecord = {
  event: "ready";
  pid: number;
  port: number;
};

const isolatedRoot = mkdtempSync(join(tmpdir(), "modus-auth-bootstrap-"));
const readinessPath = join(isolatedRoot, "runtime", "ready.json");
const agentToken = "integration-agent-token";
let backend: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let baseUrl = "";
let childPid: number | null = null;

function isolatedProcessEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function waitForReadiness(timeoutMs = 20_000): Promise<ReadinessRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(readinessPath)) {
      return JSON.parse(readFileSync(readinessPath, "utf8")) as ReadinessRecord;
    }
    if (backend?.exitCode !== null) {
      throw new Error(`isolated backend exited before readiness (${backend?.exitCode})`);
    }
    await Bun.sleep(50);
  }
  throw new Error("isolated backend did not publish readiness in time");
}

beforeAll(async () => {
  backend = Bun.spawn([process.execPath, "run", "index.ts"], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...isolatedProcessEnvironment(),
      NODE_ENV: "test",
      AGENT_CWD: isolatedRoot,
      HARNESS_HOST: "127.0.0.1",
      HARNESS_PORT: "0",
      HARNESS_TOKEN: agentToken,
      HARNESS_SECRETS_FILE: join(isolatedRoot, "config", "secrets.env"),
      MODUS_HOME: isolatedRoot,
      MODUS_DATA_DIR: join(isolatedRoot, "data"),
      MODUS_LOGS_DIR: join(isolatedRoot, "logs"),
      MODUS_RUNTIME_DIR: join(isolatedRoot, "runtime"),
      MODUS_CACHE_DIR: join(isolatedRoot, "cache"),
      MODUS_RESOURCES_DIR: import.meta.dir,
      MODUS_DESKTOP_READY_FILE: readinessPath,
    },
  });
  childPid = backend.pid;
  const ready = await waitForReadiness();
  expect(ready.pid).toBe(childPid);
  expect(ready.port).toBeGreaterThan(0);
  baseUrl = `http://127.0.0.1:${ready.port}`;
});

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) await backend.exited;
  rmSync(isolatedRoot, { recursive: true, force: true });
  if (childPid !== null) {
    rmSync(join(tmpdir(), "modus-tests", String(childPid)), { recursive: true, force: true });
  }
});

describe("isolated browser authentication bootstrap", () => {
  test("status is public, advertises token protection, and does not require a URL token", async () => {
    const response = await fetch(`${baseUrl}/api/auth/status`);
    expect(response.status).toBe(200);
    const status = await response.json() as { required: boolean; tokenRequired: boolean };
    expect(status.required).toBe(false);
    expect(status.tokenRequired).toBe(true);
  });

  test("a no-PIN browser session receives a distinct token that authorizes protected APIs", async () => {
    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { method: "POST" });
    expect(sessionResponse.status).toBe(200);
    const { token } = await sessionResponse.json() as { token: string };
    expect(token).toBeTruthy();
    expect(token).not.toBe(agentToken);

    const unauthenticated = await fetch(`${baseUrl}/api/sessions`);
    expect(unauthenticated.status).toBe(401);

    const authenticated = await fetch(`${baseUrl}/api/auth/check`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toMatchObject({ ok: true, kind: "browser" });
  });

  test("a PIN-configured backend refuses the no-PIN session route", async () => {
    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "integration-pin", name: "tester" }),
    });
    expect(setupResponse.status).toBe(200);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { method: "POST" });
    expect(sessionResponse.status).toBe(403);
  });
});
