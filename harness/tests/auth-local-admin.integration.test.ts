import { resolve as resolveTestSourceDir } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type ReadinessRecord = { pid: number; port: number };

const isolatedRoot = mkdtempSync(join(tmpdir(), "modus-local-auth-admin-"));
const readinessPath = join(isolatedRoot, "runtime", "ready.json");
let backend: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let baseUrl = "";

function isolatedProcessEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

beforeAll(async () => {
  backend = Bun.spawn([process.execPath, "run", "index.ts"], {
    cwd: resolveTestSourceDir(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...isolatedProcessEnvironment(),
      NODE_ENV: "test",
      AGENT_CWD: isolatedRoot,
      HARNESS_HOST: "127.0.0.1",
      HARNESS_PORT: "0",
      HARNESS_SECRETS_FILE: join(isolatedRoot, "config", "secrets.env"),
      MODUS_HOME: isolatedRoot,
      MODUS_DATA_DIR: join(isolatedRoot, "data"),
      MODUS_LOGS_DIR: join(isolatedRoot, "logs"),
      MODUS_RUNTIME_DIR: join(isolatedRoot, "runtime"),
      MODUS_CACHE_DIR: join(isolatedRoot, "cache"),
      MODUS_RESOURCES_DIR: resolveTestSourceDir(import.meta.dir, ".."),
      MODUS_DESKTOP_READY_FILE: readinessPath,
    },
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(readinessPath) && Date.now() < deadline) await Bun.sleep(50);
  if (!existsSync(readinessPath)) throw new Error("local auth-admin backend did not become ready");
  const ready = JSON.parse(readFileSync(readinessPath, "utf8")) as ReadinessRecord;
  baseUrl = `http://127.0.0.1:${ready.port}`;
});

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) await backend.exited;
  rmSync(isolatedRoot, { recursive: true, force: true });
  if (backend?.pid) rmSync(join(tmpdir(), "modus-tests", String(backend.pid)), { recursive: true, force: true });
});

describe("tokenless local PIN recovery boundary", () => {
  test("permits the loopback host but rejects a forwarded Tailnet caller", async () => {
    const status = await fetch(`${baseUrl}/api/auth/status`).then((response) => response.json()) as { canManagePin: boolean };
    expect(status.canManagePin).toBe(true);

    const remoteSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "machine.example.ts.net",
        "X-Forwarded-For": "100.64.0.9",
      },
      body: JSON.stringify({ pin: "remote-pin" }),
    });
    expect(remoteSetup.status).toBe(403);

    const localSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "local-pin" }),
    });
    expect(localSetup.status).toBe(200);

    const localReset = await fetch(`${baseUrl}/api/auth/reset-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPin: "replacement-pin" }),
    });
    expect(localReset.status).toBe(200);
    const oldPin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "local-pin" }),
    });
    const newPin = await fetch(`${baseUrl}/api/auth/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "replacement-pin" }),
    });
    expect(oldPin.status).toBe(401);
    expect(newPin.status).toBe(200);
  });
});
