import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

const root = mkdtempSync(join(tmpdir(), "modus-sse-revoke-"));
const readyPath = join(root, "runtime", "ready.json");
const agentToken = "isolated-sse-agent";
const sessionId = `sse-revoke-${crypto.randomUUID()}`;
const eventCount = 10;
const pausePath = join(root, "runtime", "sse-paused");
const releasePath = join(root, "runtime", "sse-release");
let backend: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
let baseUrl = "";
let childPid: number | null = null;
const backendErrors: string[] = [];

beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  backend = Bun.spawn([process.execPath, "run", "tests/fixtures/sse-revocation-backend.ts"], {
    cwd: resolve(import.meta.dir, ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...env,
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
      MODUS_SSE_PAUSE_MARKER: pausePath,
      MODUS_SSE_RELEASE_MARKER: releasePath,
    },
  });
  childPid = backend.pid;
  void (async () => { for await (const chunk of backend!.stderr) backendErrors.push(new TextDecoder().decode(chunk)); })();
  const deadline = Date.now() + 20_000;
  while (!existsSync(readyPath)) {
    if (backend.exitCode !== null) throw new Error(`isolated backend exited (${backend.exitCode})`);
    if (Date.now() > deadline) throw new Error("isolated backend did not become ready");
    await Bun.sleep(50);
  }
  const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { port: number };
  baseUrl = `http://127.0.0.1:${ready.port}`;
  const db = new Database(join(tmpdir(), "modus-tests", String(childPid), "harness.db"));
  try {
    db.run("INSERT INTO sessions (id, preview, status, created_at, updated_at) VALUES (?, 'SSE fixture', 'done', 1, 1)", [sessionId]);
    const insert = db.prepare("INSERT INTO events (session_id, seq, type, subtype, data, created_at) VALUES (?, ?, 'assistant', NULL, ?, 1)");
    const payload = "x".repeat(100);
    db.transaction(() => {
      for (let seq = 1; seq <= eventCount; seq++) insert.run(sessionId, seq, JSON.stringify({ type: "assistant", seq, payload }));
    })();
  } finally { db.close(); }
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "sse-pin", name: "fixture" }),
  });
  expect(setup.status).toBe(200);
}, 30_000);

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) await backend.exited;
  await removeTreeAfterExit(root);
  if (childPid !== null) await removeTreeAfterExit(join(tmpdir(), "modus-tests", String(childPid)));
}, 15_000);

async function browserToken(): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: "sse-pin" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

test.each(["single", "multi"] as const)("%s SSE stops catch-up when its browser session is revoked", async (route) => {
  if (existsSync(pausePath)) unlinkSync(pausePath);
  if (existsSync(releasePath)) unlinkSync(releasePath);
  const token = await browserToken();
  const url = route === "single"
    ? `${baseUrl}/api/sessions/${sessionId}/events`
    : `${baseUrl}/api/events/multi?token=${encodeURIComponent(token)}&sessions=${encodeURIComponent(JSON.stringify([{ i: sessionId, s: 0 }]))}`;
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: route === "single" ? { Authorization: `Bearer ${token}` } : undefined,
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const first = await reader.read();
  if (first.done) console.log("backend errors", backendErrors.join(""));
  expect(first.done).toBe(false);
  const firstFrame = new TextDecoder().decode(first.value);
  expect(firstFrame).toContain("event: catchup-start");
  expect(firstFrame).not.toContain("event: assistant");
  expect(firstFrame).not.toContain('"seq":1');
  const pauseDeadline = Date.now() + 5_000;
  while (!existsSync(pausePath)) {
    if (Date.now() > pauseDeadline) throw new Error("SSE flush did not pause");
    await Bun.sleep(10);
  }
  const lock = await fetch(`${baseUrl}/api/auth/lock`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  expect(lock.status).toBe(200);
  const revoked = await fetch(`${baseUrl}/api/auth/check`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(revoked.status).toBe(401);
  writeFileSync(releasePath, "resume");
  let frames = firstFrame;
  let closed = false;
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(8_000).then(() => ({ done: true, value: undefined, timedOut: true })),
      ]);
      if ("timedOut" in next) throw new Error("SSE did not close after revocation");
      if (next.done) { closed = true; break; }
      frames += new TextDecoder().decode(next.value);
    }
  } finally { controller.abort(); }
  expect(closed).toBe(true);
  const replayed = route === "single"
    ? [...frames.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))
    : [...frames.matchAll(/"seq":(\d+),"ev"/g)].map((match) => Number(match[1]));
  expect(replayed).toEqual([]);
  expect(frames).not.toContain("event: catchup-end");
}, 20_000);
