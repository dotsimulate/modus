import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

type ReadinessRecord = { event: "ready"; pid: number; port: number };

const root = mkdtempSync(join(tmpdir(), "modus-raw-document-"));
const readyPath = join(root, "runtime", "ready.json");
const agentToken = "isolated-raw-document-token";
let backend: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let baseUrl = "";
let browserToken = "";
let childPid: number | null = null;

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
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...isolatedProcessEnvironment(),
      NODE_ENV: "test",
      AGENT_CWD: root,
      HARNESS_HOST: "127.0.0.1",
      HARNESS_PORT: "0",
      HARNESS_TOKEN: agentToken,
      HARNESS_SECRETS_FILE: join(root, "config", "secrets.env"),
      MODUS_HOME: root,
      MODUS_DATA_DIR: join(root, "data"),
      MODUS_LOGS_DIR: join(root, "logs"),
      MODUS_RUNTIME_DIR: join(root, "runtime"),
      MODUS_CACHE_DIR: join(root, "cache"),
      MODUS_RESOURCES_DIR: resolve(import.meta.dir, ".."),
      MODUS_DESKTOP_READY_FILE: readyPath,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_CACHE_HOME: join(root, "xdg-cache"),
    },
  });
  childPid = backend.pid;
  const deadline = Date.now() + 20_000;
  while (!existsSync(readyPath)) {
    if (backend.exitCode !== null) throw new Error(`isolated backend exited (${backend.exitCode})`);
    if (Date.now() >= deadline) throw new Error("isolated backend did not publish readiness");
    await Bun.sleep(50);
  }
  const ready = JSON.parse(readFileSync(readyPath, "utf8")) as ReadinessRecord;
  expect(ready.pid).toBe(childPid);
  baseUrl = `http://127.0.0.1:${ready.port}`;
  const session = await fetch(`${baseUrl}/api/auth/session`, { method: "POST" });
  expect(session.status).toBe(200);
  browserToken = (await session.json() as { token: string }).token;
  expect(browserToken).toBeTruthy();
  expect(browserToken).not.toBe(agentToken);
}, 30_000);

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) await backend.exited;
  await removeTreeAfterExit(root);
  if (childPid !== null) await removeTreeAfterExit(join(tmpdir(), "modus-tests", String(childPid)));
}, 15_000);

async function ticketedResponse(name: string, contents: string): Promise<Response> {
  const filePath = join(root, name);
  writeFileSync(filePath, contents);
  const minted = await fetch(`${baseUrl}/api/file/ticket`, {
    method: "POST",
    headers: { Authorization: `Bearer ${browserToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });
  expect(minted.status).toBe(200);
  const { ticket } = await minted.json() as { ticket: string };
  return fetch(`${baseUrl}/api/file/raw?path=${encodeURIComponent(filePath)}&ticket=${encodeURIComponent(ticket)}`);
}

describe("ticketed raw-file document responses", () => {
  test.each([
    ["page.html", "text/html", "<script>parent.localStorage.getItem('modus')</script>"],
    ["drawing.svg", "image/svg+xml", "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"],
    ["photo.png", "image/png", "image bytes"],
    ["paper.pdf", "application/pdf", "pdf bytes"],
  ])("sandboxes %s without removing its preview MIME type", async (name, mime, contents) => {
    const response = await ticketedResponse(name, contents);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith(mime);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toMatch(/(?:^|;)\s*sandbox(?:;|$)/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-scripts");
    expect(csp).toContain("script-src 'none'");
    expect(await response.text()).toBe(contents);
  });
});
