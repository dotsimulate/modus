import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";
import { createInitialState, reduceEvent } from "../ui/src/eventReducer";
import { createLiveSnapshotDecoder } from "../live-snapshot-codec";

const root = mkdtempSync(join(tmpdir(), "modus-sse-replay-"));
const readyPath = join(root, "runtime", "ready.json");
const token = "isolated-sse-replay";
let backend: Bun.Subprocess<"ignore", "ignore", "pipe">;
let baseUrl = "";
let errors = "";

beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  backend = Bun.spawn([process.execPath, "run", "tests/fixtures/sse-replay-backend.ts"], {
    cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: {
      ...env, NODE_ENV: "test", AGENT_CWD: root,
      HARNESS_HOST: "127.0.0.1", HARNESS_PORT: "0", HARNESS_TOKEN: token,
      HARNESS_SECRETS_FILE: join(root, "config", "secrets.env"), MODUS_HOME: root,
      XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache"),
      MODUS_DATA_DIR: join(root, "data"), MODUS_LOGS_DIR: join(root, "logs"),
      MODUS_RUNTIME_DIR: join(root, "runtime"), MODUS_CACHE_DIR: join(root, "cache"),
      MODUS_RESOURCES_DIR: resolve(import.meta.dir, ".."), MODUS_DESKTOP_READY_FILE: readyPath,
    },
  });
  void (async () => { for await (const chunk of backend.stderr) errors += new TextDecoder().decode(chunk); })();
  const deadline = Date.now() + 20_000;
  while (!existsSync(readyPath)) {
    if (backend.exitCode !== null) throw new Error(`isolated backend exited: ${errors}`);
    if (Date.now() > deadline) throw new Error(`isolated backend did not become ready: ${errors}`);
    await Bun.sleep(25);
  }
  baseUrl = `http://127.0.0.1:${JSON.parse(readFileSync(readyPath, "utf8")).port}`;
}, 30_000);

afterAll(async () => {
  if (backend && backend.exitCode === null) backend.kill();
  if (backend) {
    await backend.exited;
    await removeTreeAfterExit(join(tmpdir(), "modus-tests", String(backend.pid)), 100);
  }
  await removeTreeAfterExit(root);
}, 15_000);

test("single and multiplexed clients receive interjections sent during catch-up and retain them on reload", async () => {
  for (const [index, route] of ["single", "multi", "multi-delta"].entries()) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 3000);
    let transcript = "";
    try {
      const response = await fetch(route === "single"
        ? `${baseUrl}/api/sessions/sse-replay-fixture/events`
        : `${baseUrl}/api/events/multi`, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(route !== "single" ? { method: "POST", body: JSON.stringify({ sessions: [{ i: "sse-replay-fixture", s: 0 }], liveDeltas: route === "multi-delta" }) } : {}),
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const needle = '"content":"continue"';
      try {
        while (transcript.split(needle).length < index + 2 || !transcript.includes(` stream-marker-${index + 1}`)) {
          const chunk = await reader.read();
          if (chunk.done) break;
          transcript += new TextDecoder().decode(chunk.value);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
      expect(transcript).toContain(needle);
      expect(transcript.split(needle)).toHaveLength(index + 2);
      expect(transcript.includes('"subtype":"live_delta"')).toBe(route === "multi-delta");
      // Rebuild the client exactly as a fresh browser does when replaying SSE.
      // Repeated text must retain both sends, including on the second client.
      let state = createInitialState("sse-replay-fixture");
      const decodeLive = createLiveSnapshotDecoder();
      let seq = 0;
      for (const line of transcript.split("\n")) {
        if (line.startsWith("id: ")) seq = Number(line.slice(4));
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.slice(6));
        if (route !== "single" && data.ev) state = reduceEvent(state, decodeLive(data.sid, data.seq, data.ev), data.seq);
        else if (route === "single" && data.type) state = reduceEvent(state, data, seq);
      }
      expect(state.messages.filter((message) => message.role === "user").map((message) => message.content))
        .toEqual(["opening", ...Array(index + 1).fill("continue")]);
      expect(state.messages.at(-1)?.content).toContain(` stream-marker-${index + 1}`);
    } finally {
      clearTimeout(deadline);
      controller.abort();
    }
  }
  const response = await fetch(`${baseUrl}/api/sessions/sse-replay-fixture/history-snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const snapshot = await response.json() as { messages: Array<{ role: string; text: string }> };
  expect(snapshot.messages.filter((message) => message.role === "user").map((message) => message.text))
    .toEqual(["opening", "continue", "continue", "continue"]);
}, 10_000);
