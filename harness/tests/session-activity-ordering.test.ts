import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addEvent,
  getSession,
  insertMessage,
  repairReapedSessionActivity,
  syncSessionMessageCount,
  updateSessionTags,
  updateSessionTitle,
  upsertSession,
} from "../db";

/**
 * `last_message_at` is the session-list ordering key (`ORDER BY last_message_at
 * DESC`). These pin which writes may move it, because three separate reports of
 * "old chats jumping to the top" all came down to something touching it that was
 * not the conversation: a reclamation notice, a rename, and a pin/unpin.
 *
 * Each test advances the clock past the session's creation first, so "unchanged"
 * cannot pass by landing in the same millisecond.
 */

async function makeAgedSession(preview: string): Promise<{ id: string; before: number }> {
  const id = `activity-${crypto.randomUUID()}`;
  upsertSession({ id, preview, messageCount: 0, costUsd: 0 });
  const before = getSession(id)!.last_message_at;
  await Bun.sleep(5);
  return { id, before };
}

test("a harness-written notice does not move the session up the list", async () => {
  const { id, before } = await makeAgedSession("reclaimed session");

  // Exactly what reclaimSession does: persist the notice, reconcile the count.
  insertMessage({
    sessionId: id,
    seq: 1,
    role: "system",
    content: "Session process reclaimed: idle.",
    createdAt: Date.now(),
  });
  syncSessionMessageCount(id, { touchActivity: false });

  const after = getSession(id)!;
  expect(after.last_message_at).toBe(before);
  expect(after.message_count).toBe(1);
  // The row was still written, which is what updated_at is for.
  expect(after.updated_at).toBeGreaterThan(before);
});

test("startup repair restores activity already poisoned by an older reap", async () => {
  const { id, before } = await makeAgedSession("historically reclaimed session");
  const activityAt = before + 1;
  insertMessage({
    sessionId: id,
    seq: 1,
    role: "assistant",
    content: "the real last reply",
    createdAt: activityAt,
  });
  syncSessionMessageCount(id, { activityAt });

  await Bun.sleep(5);
  addEvent(id, 2, "system", "reclaimed", JSON.stringify({ type: "system", subtype: "reclaimed" }));
  insertMessage({
    sessionId: id,
    seq: 2,
    role: "system",
    content: "Session process reclaimed: idle.",
    createdAt: Date.now(),
  });
  syncSessionMessageCount(id); // Reproduce the pre-fix reap-time activity bump.
  expect(getSession(id)!.last_message_at).toBeGreaterThan(activityAt);

  expect(repairReapedSessionActivity()).toBeGreaterThanOrEqual(1);
  expect(getSession(id)!.last_message_at).toBe(activityAt);
  expect(repairReapedSessionActivity()).toBe(0);
});

test("startup repair preserves real conversation activity after a reclaim", async () => {
  const { id } = await makeAgedSession("resumed after reclaim");
  addEvent(id, 1, "system", "reclaimed", JSON.stringify({ type: "system", subtype: "reclaimed" }));
  await Bun.sleep(5);
  const resumedAt = Date.now();
  insertMessage({ sessionId: id, seq: 2, role: "user", content: "continue", createdAt: resumedAt });
  syncSessionMessageCount(id, { activityAt: resumedAt });

  repairReapedSessionActivity();
  expect(getSession(id)!.last_message_at).toBe(resumedAt);
});

test("an ordinary turn still moves the session up the list", async () => {
  const { id, before } = await makeAgedSession("live session");

  insertMessage({ sessionId: id, seq: 1, role: "assistant", content: "replying", createdAt: Date.now() });
  syncSessionMessageCount(id);

  expect(getSession(id)!.last_message_at).toBeGreaterThan(before);
});

test("delayed assistant materialization preserves the turn activity time", async () => {
  const { id, before } = await makeAgedSession("buffered assistant turn");
  const activityAt = before + 1;

  insertMessage({
    sessionId: id,
    seq: 1,
    role: "assistant",
    content: "reply buffered before reap",
    createdAt: activityAt,
  });
  await Bun.sleep(5);
  syncSessionMessageCount(id, { activityAt });

  const after = getSession(id)!;
  expect(after.last_message_at).toBe(activityAt);
  expect(after.updated_at).toBeGreaterThan(activityAt);
  expect(after.last_message_at).toBeLessThan(Date.now());
});

test("reap flush wires the pending turn timestamp through persistence", () => {
  const source = readFileSync(join(import.meta.dir, "..", "session-manager.ts"), "utf8");
  const start = source.indexOf("function flushPendingAssistantTurn");
  const end = source.indexOf("function persistSemanticMessage", start);
  const body = source.slice(start, end);

  expect(body).toContain("createdAt: turn.timestamp");
  expect(body).toContain("syncSessionMessageCount(session.sessionId, { activityAt: turn.timestamp })");
  expect(body).not.toContain("createdAt: Date.now()");
});

function methodBody(source: string, name: string): string {
  const start = source.indexOf(`${name}(`);
  if (start < 0) throw new Error(`missing method ${name}`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated method ${name}`);
}

test("provider callbacks become inert after their session is reaped", () => {
  const source = readFileSync(join(import.meta.dir, "..", "session-manager.ts"), "utf8");
  const factoryStart = source.indexOf("function createTurnContext");
  const factoryEnd = source.indexOf("\n// \u2500\u2500 Start Session", factoryStart);
  const factory = source.slice(factoryStart, factoryEnd);

  expect(factory).toContain(
    "activeSessions.get(session.sessionId) === session",
  );
  for (const method of [
    "emitEvent",
    "broadcastEvent",
    "notifyConfigChange",
    "rekeySession",
    "setProviderSessionId",
    "updateSessionDb",
  ]) {
    expect(methodBody(factory, method)).toContain(
      "if (!isCurrentProviderSession()) return;",
    );
  }
});

test("renaming a session does not move it up the list", async () => {
  const { id, before } = await makeAgedSession("to be renamed");

  updateSessionTitle(id, "a better name");

  expect(getSession(id)!.last_message_at).toBe(before);
});

test("pinning and unpinning does not move a session up the list", async () => {
  const { id, before } = await makeAgedSession("to be pinned");

  updateSessionTags(id, ["pinned"]);
  expect(getSession(id)!.last_message_at).toBe(before);

  await Bun.sleep(5);
  updateSessionTags(id, []);
  expect(getSession(id)!.last_message_at).toBe(before);
});
