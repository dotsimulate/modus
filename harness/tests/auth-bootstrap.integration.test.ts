import { resolve as resolveTestSourceDir } from "node:path";
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
      HARNESS_TOKEN: agentToken,
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

    const queryCredentialOnAuthCheck = await fetch(
      `${baseUrl}/api/auth/check?token=${encodeURIComponent(token)}`,
    );
    expect(queryCredentialOnAuthCheck.status).toBe(401);
    const queryCredentialOnGeneralApi = await fetch(`${baseUrl}/api/sessions?token=${encodeURIComponent(token)}`);
    expect(queryCredentialOnGeneralApi.status).toBe(401);
    const queryCredentialOnMutation = await fetch(`${baseUrl}/api/profiles/query-token-test?token=${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(queryCredentialOnMutation.status).toBe(401);
    const scopedResourceQuery = await fetch(`${baseUrl}/api/file/raw?token=${encodeURIComponent(token)}`);
    expect(scopedResourceQuery.status).toBe(400);

    // The supervisor bearer must never authenticate from a query string, even on
    // the resource routes that do accept a bounded browser-session token. A URL
    // ends up in history, copied links, and proxy logs, and this credential
    // cannot be revoked without restarting the backend.
    for (const path of [
      "/api/file/raw",
      "/api/events/sessions",
      "/api/events/fs",
      "/api/events/multi",
      "/api/preview/file/anything",
      "/api/git/raw/anything",
      "/api/sessions/any/artifacts/any",
      "/api/moves/any/widget",
      "/api/moves/any/widget.css",
    ]) {
      const supervisorInQuery = await fetch(`${baseUrl}${path}?token=${encodeURIComponent(agentToken)}`);
      expect({ path, status: supervisorInQuery.status }).toEqual({ path, status: 401 });
    }
  });

  test("a header-authenticated operator can exchange its bearer for a bounded session token", async () => {
    const exchange = await fetch(`${baseUrl}/api/auth/exchange`, {
      method: "POST",
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(exchange.status).toBe(200);
    const minted = ((await exchange.json()) as { token: string }).token;
    expect(typeof minted).toBe("string");
    expect(minted).not.toBe(agentToken);

    // The minted token is what may ride in a resource URL.
    const usable = await fetch(`${baseUrl}/api/file/raw?token=${encodeURIComponent(minted)}`);
    expect(usable.status).toBe(400);

    // Exchange itself refuses an unauthenticated caller and a query credential.
    const unauthenticated = await fetch(`${baseUrl}/api/auth/exchange`, { method: "POST" });
    expect(unauthenticated.status).toBe(401);
    const viaQuery = await fetch(`${baseUrl}/api/auth/exchange?token=${encodeURIComponent(agentToken)}`, {
      method: "POST",
    });
    expect(viaQuery.status).toBe(401);
  });

  test("only the local host can manage the PIN and every auth change revokes browsers", async () => {
    const remoteSetup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: "integration-pin", name: "tester" }),
    });
    expect(remoteSetup.status).toBe(403);

    const setupResponse = await fetch(`${baseUrl}/api/auth/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ pin: "integration-pin", name: "tester" }),
    });
    expect(setupResponse.status).toBe(200);

    const anonymousNameChange = await fetch(`${baseUrl}/api/auth/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "intruder" }),
    });
    expect(anonymousNameChange.status).toBe(401);

    const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { method: "POST" });
    expect(sessionResponse.status).toBe(403);

    const publicStatus = await fetch(`${baseUrl}/api/auth/status`).then((response) => response.json()) as { canManagePin: boolean };
    const localStatus = await fetch(`${baseUrl}/api/auth/status`, {
      headers: { Authorization: `Bearer ${agentToken}` },
    }).then((response) => response.json()) as { canManagePin: boolean };
    expect(publicStatus.canManagePin).toBe(false);
    expect(localStatus.canManagePin).toBe(true);

    const verify = async (pin: string) => {
      const response = await fetch(`${baseUrl}/api/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await response.json() as { token?: string };
      return { response, token: body.token ?? "" };
    };

    const first = await verify("integration-pin");
    expect(first.response.status).toBe(200);
    expect(first.token).toBeTruthy();

    const anonymousLock = await fetch(`${baseUrl}/api/auth/lock`, { method: "POST" });
    expect(anonymousLock.status).toBe(401);
    const authenticatedLock = await fetch(`${baseUrl}/api/auth/lock`, {
      method: "POST",
      headers: { Authorization: `Bearer ${first.token}` },
    });
    expect(authenticatedLock.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/auth/check`, {
      headers: { Authorization: `Bearer ${first.token}` },
    })).status).toBe(401);

    const second = await verify("integration-pin");
    expect(second.response.status).toBe(200);
    const streamResponse = await fetch(`${baseUrl}/api/events/multi`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${second.token}`,
      },
      body: JSON.stringify({ sessions: [{ i: "missing-session", s: 0 }] }),
    });
    expect(streamResponse.status).toBe(200);
    const streamReader = streamResponse.body?.getReader();
    expect(streamReader).toBeTruthy();
    expect((await streamReader!.read()).done).toBe(false);

    const reset = await fetch(`${baseUrl}/api/auth/reset-pin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ newPin: "replacement-pin" }),
    });
    expect(reset.status).toBe(200);
    const closedAfterReset = await Promise.race([
      streamReader!.read(),
      Bun.sleep(2_000).then(() => ({ done: false, value: undefined })),
    ]);
    expect(closedAfterReset.done).toBe(true);
    expect((await fetch(`${baseUrl}/api/auth/check`, {
      headers: { Authorization: `Bearer ${second.token}` },
    })).status).toBe(401);
    expect((await verify("integration-pin")).response.status).toBe(401);
    expect((await verify("replacement-pin")).response.status).toBe(200);
  });
});
