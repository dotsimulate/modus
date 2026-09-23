import { expect, test } from "bun:test";
import { Hono } from "hono";
import { getSession, markSessionReplyRead, recordSessionReply, renameSession, updateSessionTitle, updateSessionStatus, upsertSession } from "../db";
import { registerSessionReadRoute } from "../session-read";

function session() {
  const id = `read-${crypto.randomUUID()}`;
  upsertSession({ id, preview: "read receipt fixture", messageCount: 0, costUsd: 0 });
  return id;
}

test("read receipts are monotonic, bounded, and never mark a newer reply read", () => {
  const id = session();
  const before = getSession(id)!;
  expect(before.last_reply_seq).toBe(0);
  recordSessionReply(id, 10);
  markSessionReplyRead(id, 10);
  recordSessionReply(id, 20);
  expect(markSessionReplyRead(id, 10)).toMatchObject({ last_reply_seq: 20, read_reply_seq: 10 });
  recordSessionReply(id, 5);
  expect(markSessionReplyRead(id, 999)).toMatchObject({ last_reply_seq: 20, read_reply_seq: 20 });
  expect(getSession(id)).toMatchObject({ last_message_at: before.last_message_at, updated_at: before.updated_at, status: before.status });
  recordSessionReply(id, 30);
  updateSessionTitle(id, "renamed");
  updateSessionStatus(id, "running");
  expect(getSession(id)).toMatchObject({ last_reply_seq: 30, read_reply_seq: 20 });
  const newId = `read-rekey-${crypto.randomUUID()}`;
  renameSession(id, newId);
  expect(getSession(newId)).toMatchObject({ last_reply_seq: 30, read_reply_seq: 20 });
});

test("read API validates input, preserves other sessions and broadcasts authoritative state", async () => {
  const id = session();
  const other = session();
  recordSessionReply(id, 12);
  recordSessionReply(other, 15);
  const events: unknown[] = [];
  const app = new Hono();
  const oldId = `old-${id}`;
  registerSessionReadRoute(app, (...event) => events.push(event), (target) => target === oldId ? id : target);
  const request = (target: string, body: unknown) => app.request(`/api/sessions/${target}/read`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const seq of [-1, 1.5, "12", null, Number.MAX_SAFE_INTEGER + 1]) {
    expect((await request(id, { seq })).status).toBe(400);
  }
  expect((await request("missing", { seq: 12 })).status).toBe(404);
  const response = await request(id, { seq: 12 });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ last_reply_seq: 12, read_reply_seq: 12 });
  expect(events).toEqual([[id, 12, 12]]);
  expect((await request(oldId, { seq: 12 })).status).toBe(200);
  expect(events.at(-1)).toEqual([id, 12, 12]);
  expect(getSession(oldId)).toBeNull();
  expect(getSession(other)).toMatchObject({ last_reply_seq: 15, read_reply_seq: 0 });
});
