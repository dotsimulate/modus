import { resolve as resolveTestSourceDir } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { removeTreeAfterExit } from "./fixtures/remove-tree";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ReadinessRecord = { event: "ready"; pid: number; port: number };
type CredentialRecord = { credential: string; sessionId: string };

const isolatedRoot = mkdtempSync(join(tmpdir(), "modus-session-mcp-auth-"));
const readinessPath = join(isolatedRoot, "runtime", "ready.json");
const credentialPath = join(isolatedRoot, "runtime", "mcp-credential.json");
const revokePath = join(isolatedRoot, "runtime", "revoke-mcp");
let backend: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let baseUrl = "";
let credential = "";
let childPid: number | null = null;

function isolatedProcessEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (backend?.exitCode !== null) {
      const stderr = backend ? await new Response(backend.stderr).text() : "";
      throw new Error(`isolated backend exited early (${backend?.exitCode}): ${stderr.slice(0, 2_000)}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(25);
  }
}

beforeAll(async () => {
  mkdirSync(join(isolatedRoot, "runtime"), { recursive: true });
  backend = Bun.spawn([
    process.execPath,
    "run",
    "tests/fixtures/session-mcp-auth-backend.ts",
  ], {
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
      HARNESS_TOKEN: "integration-supervisor-token",
      HARNESS_SECRETS_FILE: join(isolatedRoot, "config", "secrets.env"),
      MODUS_HOME: isolatedRoot,
      MODUS_DATA_DIR: join(isolatedRoot, "data"),
      MODUS_LOGS_DIR: join(isolatedRoot, "logs"),
      MODUS_RUNTIME_DIR: join(isolatedRoot, "runtime"),
      MODUS_CACHE_DIR: join(isolatedRoot, "cache"),
      MODUS_RESOURCES_DIR: resolveTestSourceDir(import.meta.dir, ".."),
      MODUS_DESKTOP_READY_FILE: readinessPath,
      MODUS_TEST_MCP_CREDENTIAL_FILE: credentialPath,
      MODUS_TEST_MCP_REVOKE_FILE: revokePath,
    },
  });
  childPid = backend.pid;
  await Promise.all([waitForFile(readinessPath), waitForFile(credentialPath)]);
  const ready = JSON.parse(readFileSync(readinessPath, "utf8")) as ReadinessRecord;
  const record = JSON.parse(readFileSync(credentialPath, "utf8")) as CredentialRecord;
  baseUrl = `http://127.0.0.1:${ready.port}`;
  credential = record.credential;
  // waitForFile defaults to a 20s deadline, but Bun's default hook budget is
  // 5s — so the deadline was unreachable and the hook died mid-wait on a slow
  // runner. The budget must exceed the deadline it guards.
}, 30_000);

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) await backend.exited;
  await removeTreeAfterExit(isolatedRoot);
  if (childPid !== null) await removeTreeAfterExit(join(tmpdir(), "modus-tests", String(childPid)));
  // Kill, await exit, and unlink a tree can outrun the 5s default under load.
}, 15_000);

async function initialize(path = "/api/mcp/modus/integration-scope") {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "session-mcp-auth-test", version: "1" },
      },
    }),
  });
}

describe("session MCP HTTP authorization", () => {
  test("accepts the credential only on its exact scoped MCP endpoint", async () => {
    expect((await initialize()).status).toBe(200);
    expect((await initialize("/api/mcp/modus")).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${credential}` },
    })).status).toBe(401);
  });

  test("rejects the credential after its session is revoked", async () => {
    writeFileSync(revokePath, "revoke", "utf8");
    const deadline = Date.now() + 2_000;
    let status = 200;
    while (status === 200 && Date.now() < deadline) {
      await Bun.sleep(25);
      status = (await initialize()).status;
    }
    expect(status).toBe(401);
  });
});
