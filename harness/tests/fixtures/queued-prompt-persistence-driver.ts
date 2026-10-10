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
  // Every shipped provider records the prompt once it has delivered one. That
  // record is what makes the queue-time row a duplicate rather than the only
  // one, so the fixture has to reproduce it.
  sendMessage(ctx: TurnContext, content: unknown) {
    context = ctx;
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content } });
  },
  abort() {},
} as SessionProvider;
mock.module("../../providers/registry", () => ({ getProvider: () => fakeProvider }));

const { startSessionWithMoves, queueMessage } = await import("../../session-manager");
const { getSessionMessages, getEvents, db } = await import("../../db");
const { QUEUED_PROMPT_SUBTYPE } = await import("../../session-history");

const FOLLOW_UP = "follow-up question";

function promptRows(sessionId: string, subtype: string) {
  return getEvents(sessionId, 0).filter((row: any) =>
    row.type === "user" && row.subtype === subtype && String(row.data).includes(FOLLOW_UP));
}

try {
  const session = await startSessionWithMoves({ sessionId: "queued-prompt-fixture", cwd, prompt: "opening question" });
  context!.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } });
  context!.emitEvent({ type: "result", subtype: "success" });
  session.status = "idle";

  queueMessage(session.sessionId, FOLLOW_UP);
  const deadline = Date.now() + 5000;
  while (promptRows(session.sessionId, "prompt").length === 0 && Date.now() < deadline) await Bun.sleep(10);

  // One durable row for the queued message, one for the delivered message.
  // Both persist; only the delivered one claims to be a turn.
  assert.equal(promptRows(session.sessionId, QUEUED_PROMPT_SUBTYPE).length, 1);
  assert.equal(promptRows(session.sessionId, "prompt").length, 1);

  const userTurns = getSessionMessages(session.sessionId).filter((turn) => turn.role === "user");
  assert.deepEqual(userTurns.map((turn) => turn.text), ["opening question", FOLLOW_UP]);

  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
