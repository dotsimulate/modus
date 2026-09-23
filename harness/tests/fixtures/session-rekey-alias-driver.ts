import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import type { TurnContext, SessionProvider } from "../../providers/types";

const cwd = join(process.env.MODUS_HOME!, "fixture-project");
mkdirSync(cwd, { recursive: true });

let context: TurnContext;
const fakeProvider = {
  capabilities: {},
  startTurn(ctx: TurnContext) {
    context = ctx;
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content: ctx.opts.prompt } });
    ctx.emitEvent({ type: "system", subtype: "init", session_id: ctx.session.sessionId });
  },
  sendMessage(ctx: TurnContext, content: unknown) {
    context = ctx;
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
  },
  abort() {},
} as SessionProvider;
mock.module("../../providers/registry", () => ({ getProvider: () => fakeProvider }));

const { startSessionWithMoves, getActiveSession, subscribe, subscribeGlobal, queueMessage, interactWithSession, shutdownAll, resolveSessionAlias } = await import("../../session-manager");
const { getEvents, getSession, db } = await import("../../db");

const OLD_ID = "rekey-fixture-old";
const NEW_ID = "rekey-fixture-new";
const FOLLOW_UP = "follow-up after rename";

function writer(into: Array<{ event: string; data: any }>) {
  return {
    async write(event: string, data: string) { into.push({ event, data: JSON.parse(data) }); },
    close() {},
  };
}

try {
  const session = await startSessionWithMoves({ sessionId: OLD_ID, cwd, prompt: "opening question" });
  const live: Array<{ event: string; data: any }> = [];
  subscribe(OLD_ID, writer(live));
  const global: any[] = [];
  subscribeGlobal({ async write(data: string) { global.push(JSON.parse(data)); }, close() {} });

  // The provider renames the session after the client already holds the old id.
  context!.rekeySession(NEW_ID);
  assert.equal(session.sessionId, NEW_ID);
  assert.equal(getSession(OLD_ID), null);

  // Subscribers are told to follow, live; the index hears about it too.
  const notice = live.find((entry) => entry.data?.subtype === "session_rekeyed");
  assert.deepEqual(notice?.data, { type: "system", subtype: "session_rekeyed", from: OLD_ID, to: NEW_ID });
  assert.ok(global.some((event) => event.type === "session:rekeyed" && event.sessionId === NEW_ID && event.previousId === OLD_ID));
  // Live-only: a replay must not re-announce it.
  assert.ok(!getEvents(NEW_ID, 0).some((row: any) => String(row.data).includes("session_rekeyed")));

  // A client still holding the old id reaches the renamed session…
  assert.equal(getActiveSession(OLD_ID), session);
  const lateSubscriber: Array<{ event: string; data: any }> = [];
  const before = session.subscribers.size;
  subscribe(OLD_ID, writer(lateSubscriber));
  assert.equal(session.subscribers.size, before + 1);

  // …and what it sends is recorded under the new id, not a resurrected old row.
  context!.emitEvent({ type: "result", subtype: "success" });
  session.status = "idle";
  queueMessage(OLD_ID, FOLLOW_UP);
  const deadline = Date.now() + 5000;
  const delivered = () => getEvents(NEW_ID, 0).some((row: any) => row.subtype === "prompt" && String(row.data).includes(FOLLOW_UP));
  while (!delivered() && Date.now() < deadline) await Bun.sleep(10);
  assert.ok(delivered(), "follow-up sent under the old id reached the renamed session");
  assert.equal(getEvents(OLD_ID, 0).length, 0);
  assert.equal(getSession(OLD_ID), null);

  const queued = await interactWithSession({ sessionId: OLD_ID, prompt: "queued via old handle", createIfMissing: false });
  assert.equal(queued.sessionId, NEW_ID, "interaction returns the canonical id");

  // Reclaimed sessions resume from persisted history, where the old row no longer exists.
  await shutdownAll();
  assert.equal(getActiveSession(NEW_ID), undefined);
  const resumed = await interactWithSession({ sessionId: OLD_ID, prompt: "resume via old handle", createIfMissing: false });
  assert.equal(resumed.sessionId, NEW_ID);
  assert.equal(getSession(OLD_ID), null);

  for (let i = 0; i < 10; i++) context!.rekeySession(`rekey-fixture-next-${i}`);
  assert.equal(resolveSessionAlias(OLD_ID), "rekey-fixture-next-9", "repeated renames keep older aliases current");

  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
