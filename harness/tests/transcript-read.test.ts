import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  addEvent,
  db,
  getSessionMessages,
  insertMessage,
  insertSessionArtifact,
  readSessionMessages,
  searchSessions,
  searchSessionsOffThread,
  upsertSession,
} from "../db";
import { resolveDatabasePath } from "../database-paths";
import { readEventTurnsOffThread, stopTranscriptReadWorker } from "../transcript-read";
import { removeTreeAfterExit } from "./fixtures/remove-tree";

afterAll(() => stopTranscriptReadWorker());

function newSession(prefix: string, model?: string): string {
  const id = `${prefix}-${crypto.randomUUID()}`;
  upsertSession({ id, preview: prefix, model, messageCount: 0, costUsd: 0 });
  return id;
}

function prompt(id: string, seq: number, text: string) {
  addEvent(id, seq, "user", "prompt", JSON.stringify({ message: { content: [{ type: "text", text }] } }));
}

/** One tool round trip followed by a final answer and a result event. */
function toolTurn(id: string, seq: number, opts: { uuid?: string; result?: string; withUsage?: boolean } = {}): number {
  let next = seq;
  addEvent(id, next++, "assistant", "message", JSON.stringify({
    ...(opts.uuid ? { uuid: opts.uuid } : {}),
    message: { content: [
      { type: "thinking", thinking: "checking the file" },
      { type: "text", text: "Reading it first." },
      { type: "tool_use", id: `tool-${seq}`, name: "Read", input: { file_path: "src/a.ts" } },
    ] },
  }));
  addEvent(id, next++, "user", "message", JSON.stringify({
    message: { content: [{ type: "tool_result", tool_use_id: `tool-${seq}`, content: opts.result ?? "file contents" }] },
  }));
  addEvent(id, next++, "assistant", "message", JSON.stringify({
    message: { content: [{ type: "text", text: "\nAll done." }] },
  }));
  addEvent(id, next++, "result", "success", JSON.stringify(opts.withUsage
    ? { subtype: "success", total_cost_usd: 0.42, num_turns: 2, modelUsage: { "claude-opus-5": { outputTokens: 900, contextWindow: 1_000_000 } } }
    : { subtype: "success" }));
  return next;
}

test("an off-thread read returns exactly the synchronous turns, artifacts included", async () => {
  const id = newSession("read-parity", "claude-opus-5-5");
  prompt(id, 1, "inspect the parser");
  let seq = toolTurn(id, 2, { uuid: "assistant-uuid-1", withUsage: true });
  prompt(id, seq++, "and the lexer");
  seq = toolTurn(id, seq);
  insertSessionArtifact({ sessionId: id, seq: 0, targetMessageUuid: "assistant-uuid-1", name: "by-uuid.txt", mime: "text/plain", path: "a.txt", createdAt: 10 });
  insertSessionArtifact({ sessionId: id, seq: 5, name: "by-seq.txt", mime: "text/plain", path: "b.txt", createdAt: 20 });

  const sync = getSessionMessages(id);
  expect(sync.length).toBe(4);
  expect(sync.some((turn) => turn.artifacts?.length)).toBe(true);
  expect(await readSessionMessages(id)).toEqual(sync);
});

test("dropping tool payloads keeps the conversation and the tool names", async () => {
  const id = newSession("read-no-payloads");
  prompt(id, 1, "check it");
  toolTurn(id, 2, { result: "x".repeat(50_000) });

  const full = getSessionMessages(id);
  const light = await readSessionMessages(id, { toolPayloads: false });
  expect(light.map((turn) => turn.text)).toEqual(full.map((turn) => turn.text));
  const call = light[1]!.toolCalls![0]!;
  expect(call).toMatchObject({ id: "tool-2", name: "Read", input: {} });
  expect(call.result).toBeUndefined();
  const block = light[1]!.contentBlocks!.find((b) => b.type === "tool_call") as { toolCall: { result?: string } };
  expect(block.toolCall.result).toBeUndefined();
  // The caller's copy is its own; the synchronous read still has everything.
  expect(getSessionMessages(id)[1]!.toolCalls![0]!.result).toHaveLength(50_000);
});

test("a session kept only as semantic rows reads through the synchronous fallback", async () => {
  const id = newSession("read-semantic");
  insertMessage({ sessionId: id, seq: 1, role: "user", content: "old question", createdAt: 1 });
  insertMessage({ sessionId: id, seq: 2, role: "assistant", content: "old answer", createdAt: 2 });

  const sync = getSessionMessages(id);
  expect(sync.map((turn) => turn.text)).toEqual(["old question", "old answer"]);
  expect(await readSessionMessages(id)).toEqual(sync);
  expect(await readSessionMessages("no-such-session")).toEqual([]);
});

test("an off-thread search returns exactly the synchronous hits", async () => {
  const cwd = `/projects/search-${crypto.randomUUID()}`;
  for (const [name, time] of [["old", 100], ["new", 300], ["middle", 200]] as const) {
    const id = `search-${name}-${crypto.randomUUID()}`;
    upsertSession({ id, preview: name, cwd, messageCount: 2, costUsd: 0 });
    db.run("UPDATE sessions SET last_message_at = ? WHERE id = ?", [time, id]);
    addEvent(id, 1, "user", null, JSON.stringify({ message: { content: "authentication setup" } }));
    addEvent(id, 2, "assistant", null, JSON.stringify({ message: { content: [{ type: "text", text: `refactor access token ${name}` }] } }));
  }
  const scope = { cwdPrefixes: [cwd] };
  for (const [query, options] of [["auth refactor", { sort: "latest" as const }], ['"access token"', { sort: "oldest" as const, offset: 1 }], ["nothing-matches", undefined]] as const) {
    const sync = searchSessions(query, 20, scope, options);
    expect(await searchSessionsOffThread(query, 20, scope, options)).toEqual(sync);
  }
  expect(searchSessions("auth refactor", 20, scope, { sort: "latest" }).map((hit) => hit.preview)).toEqual(["new", "middle", "old"]);
});

test("a read the worker cannot serve resolves to null for the caller to redo", async () => {
  const missing = join(tmpdir(), `modus-no-db-${crypto.randomUUID()}`, "harness.db");
  expect(await readEventTurnsOffThread(missing, "anything")).toBeNull();
  // The worker survives a failed query and serves the next one.
  const id = newSession("read-after-failure");
  prompt(id, 1, "still there?");
  expect(await readEventTurnsOffThread(resolveDatabasePath("harness.db"), id)).toMatchObject([{ role: "user", text: "still there?" }]);
});

test("timers keep firing while a long transcript is read off the main thread", async () => {
  const id = newSession("read-long");
  let seq = 1;
  for (let turn = 0; turn < 250; turn++) {
    prompt(id, seq++, `turn ${turn}`);
    seq = toolTurn(id, seq, { result: `result ${turn} `.repeat(1_500) });
  }

  const syncStart = performance.now();
  const sync = getSessionMessages(id);
  const syncMs = performance.now() - syncStart;

  let worstGap = 0;
  let last = performance.now();
  const probe = setInterval(() => {
    const now = performance.now();
    worstGap = Math.max(worstGap, now - last);
    last = now;
  }, 2);
  try {
    const read = await readSessionMessages(id, { toolPayloads: false });
    expect(read.length).toBe(sync.length);
  } finally {
    clearInterval(probe);
  }
  // Relative, so a slow runner scales both sides: the synchronous read holds
  // the loop for all of its work, the off-thread read for a small part of it.
  expect(worstGap).toBeLessThan(Math.max(syncMs / 2, 25));
}, 30_000);

test("a bundled reader finds its staged worker beside it", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-transcript-read-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "..", "transcript-read.ts"), join(import.meta.dir, "..", "transcript-read-worker.ts")],
      outdir: root, target: "bun", naming: "[name].js",
    });
    expect(built.success).toBe(true);
    const bundled = await import(pathToFileURL(join(root, "transcript-read.js")).href);
    const id = newSession("read-bundled");
    prompt(id, 1, "from the packaged worker");
    try {
      expect(await bundled.readEventTurnsOffThread(resolveDatabasePath("harness.db"), id))
        .toMatchObject([{ role: "user", text: "from the packaged worker" }]);
    } finally {
      bundled.stopTranscriptReadWorker();
    }
  } finally {
    await removeTreeAfterExit(root);
  }
}, 30_000);
