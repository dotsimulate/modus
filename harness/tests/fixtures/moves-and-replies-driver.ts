import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import type { TurnContext, SessionProvider } from "../../providers/types";

if (process.argv[2] === "persisted" || process.argv[2] === "other-vault") {
  const { getSession, db } = await import("../../db");
  const row = getSession("moves-replies-fixture");
  if (process.argv[2] === "persisted") {
    assert.ok(row && row.last_reply_seq > row.read_reply_seq && row.read_reply_seq > 0);
  } else {
    assert.equal(row, null);
  }
  db.close();
  process.exit(0);
}

const cwd = join(process.env.MODUS_HOME!, "fixture-project");
const received: string[] = [];
let context: TurnContext;
const fakeProvider = {
  capabilities: {},
  startTurn(ctx: TurnContext) {
    context = ctx;
    received.push(String(ctx.opts.prompt));
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content: ctx.opts.prompt } });
    ctx.emitEvent({ type: "system", subtype: "init", session_id: ctx.session.sessionId });
  },
  sendMessage(ctx: TurnContext, content: unknown) {
    context = ctx;
    received.push(String(content));
    ctx.session.status = "running";
  },
  abort() {},
} as SessionProvider;
mock.module("../../providers/registry", () => ({ getProvider: () => fakeProvider }));

for (const name of ["first", "second", "profile-context", "removed"]) {
  const dir = join(cwd, ".modus", "moves", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "move.json"), JSON.stringify({
    name, label: name, mode: "inline", api: { tokenPrefix: name, ops: { ping: { description: "Fixture ping" } } },
  }));
  writeFileSync(join(dir, "context.ts"), [
    "export const prepare = (ctx: any) => ctx.setStore({ ready: true });",
    "export const gather = (ctx: any) => { if (!ctx.store()?.ready) throw new Error('prepare was skipped'); return `fixture ${ctx.inputs.topic ?? ''} token ${ctx.apiToken}`; };",
    "export const handlers = { ping: (ctx: any) => ({ ok: true, sessionId: ctx.sessionId }) };",
  ].join("\n"));
}
const profileDir = join(cwd, ".modus", "profiles", "agents");
const promptDir = join(cwd, ".modus", "moves", "prompt-only");
mkdirSync(promptDir, { recursive: true });
writeFileSync(join(promptDir, "move.json"), JSON.stringify({
  name: "prompt-only", label: "Prompt only", prompt: "configured prompt context", submit: { required: false },
}));
mkdirSync(profileDir, { recursive: true });
writeFileSync(join(profileDir, "fixture.json"), JSON.stringify({
  prompt: "Fixture", description: "Fixture", provider: "claude-code",
  moves: [{ name: "profile-context" }, { name: "removed" }],
}));

const { startSessionWithMoves, queueMessage } = await import("../../session-manager");
const { getSession, markSessionReplyRead, updateSessionTitle, updateSessionStatus, db } = await import("../../db");
const { handleMoveApiSubmit } = await import("../../move-runner");
const moves = [{ name: "first", inputs: { topic: "alpha" } }, { name: "second", inputs: { topic: "beta" } }, { name: "prompt-only" }];
async function checkPrompt(prompt: string, sessionId: string, profile: boolean) {
  assert.ok(prompt.includes("<!-- move:first -->"));
  assert.ok(prompt.includes("<!-- move:second -->"));
  assert.ok(prompt.includes("alpha"));
  assert.ok(prompt.includes("beta"));
  assert.ok(prompt.includes("configured prompt context"));
  assert.equal(prompt.includes("<!-- move:profile-context -->"), profile);
  assert.ok(!prompt.includes("<!-- move:removed -->"));
  assert.ok(prompt.endsWith("ordinary input"));
  const tokens = [...new Set(prompt.match(/mapi-[a-z-]+-[a-z0-9]+/g))];
  assert.equal(tokens.length, profile ? 3 : 2);
  for (const token of tokens) {
    const result = await handleMoveApiSubmit(token, { op: "ping" });
    assert.equal(result.ok, true);
    assert.equal(result.sessionId, sessionId);
  }
  return tokens;
}

try {
  const session = await startSessionWithMoves({ sessionId: "moves-replies-fixture", cwd, profile: "fixture", prompt: "ordinary input", moves, skipProfileMoves: ["removed"] });
  const firstTokens = await checkPrompt(received[0]!, session.sessionId, true);
  assert.equal(getSession(session.sessionId)!.last_reply_seq, 0);
  context!.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "Working..." }, { type: "tool_use", id: "tool", name: "Read", input: {} }] } });
  assert.equal(getSession(session.sessionId)!.last_reply_seq, 0);
  context!.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "Final reply" }] } });
  context!.emitEvent({ type: "result", subtype: "success" });
  const completedSeq = session.seq;
  assert.equal(getSession(session.sessionId)!.last_reply_seq, completedSeq);
  assert.equal(getSession(session.sessionId)!.read_reply_seq, 0);
  markSessionReplyRead(session.sessionId, completedSeq);
  session.status = "idle";
  queueMessage(session.sessionId, "ordinary input", undefined, moves);
  const deadline = Date.now() + 5000;
  while (received.length < 2 && Date.now() < deadline) await Bun.sleep(10);
  assert.equal(received.length, 2);
  const secondTokens = await checkPrompt(received[1]!, session.sessionId, false);
  assert.ok(secondTokens.every((token) => !firstTokens.includes(token)));
  context!.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "Second final reply" }] } });
  context!.emitEvent({ type: "result", subtype: "success" });
  const newerSeq = session.seq;
  markSessionReplyRead(session.sessionId, completedSeq);
  updateSessionTitle(session.sessionId, "retitled");
  updateSessionStatus(session.sessionId, "running");
  assert.equal(getSession(session.sessionId)!.last_reply_seq, newerSeq);
  assert.equal(getSession(session.sessionId)!.read_reply_seq, completedSeq);
  context!.emitEvent({ type: "assistant", message: { content: [{ type: "text", text: "Interrupted partial reply" }] } });
  context!.emitEvent({ type: "result", subtype: "interrupted" });
  assert.equal(getSession(session.sessionId)!.last_reply_seq, newerSeq);
  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
