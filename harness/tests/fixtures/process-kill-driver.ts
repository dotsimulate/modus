import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";
import type { TurnContext, SessionProvider } from "../../providers/types";

const cwd = join(process.env.MODUS_HOME!, "fixture-project");
mkdirSync(cwd, { recursive: true });

let aborts = 0;
let context: TurnContext;
const fakeProvider = {
  capabilities: {},
  startTurn(ctx: TurnContext) {
    context = ctx;
    ctx.session.status = "running";
    ctx.emitEvent({ type: "user", subtype: "prompt", message: { role: "user", content: ctx.opts.prompt } });
    ctx.emitEvent({ type: "system", subtype: "init", session_id: ctx.session.sessionId });
  },
  abort() { aborts++; },
} as SessionProvider;
mock.module("../../providers/registry", () => ({ getProvider: () => fakeProvider }));

const { startSessionWithMoves, getActiveSession, subscribe, subscribeGlobal } = await import("../../session-manager");
const { killProcess } = await import("../../process-registry");
const { getEvents, getSession, db } = await import("../../db");
const { createInitialState, reduceEvent } = await import("../../ui/src/eventReducer");

type Captured = { event: string; data: any; seq: number };

function capture(sessionId: string) {
  const live: Captured[] = [];
  let closed = false;
  subscribe(sessionId, {
    async write(event: string, data: string, seq?: string) { live.push({ event, data: JSON.parse(data), seq: Number(seq) }); },
    close() { closed = true; },
  });
  return { live, isClosed: () => closed };
}

const notices = (id: string) => getEvents(id, 0).filter((row: any) => row.subtype === "reclaimed");

try {
  const global: any[] = [];
  subscribeGlobal({ async write(data: string) { global.push(JSON.parse(data)); }, close() {} });

  // Killing the session someone is watching, mid-turn: what the widget now allows.
  const RUNNING = "kill-fixture-running";
  const running = await startSessionWithMoves({ sessionId: RUNNING, cwd, prompt: "long running work" });
  const viewer = capture(RUNNING);
  assert.equal(running.status, "running");
  const orderedBefore = getSession(RUNNING)!.last_message_at;

  assert.deepEqual(killProcess(RUNNING), { ok: true });

  assert.equal(getActiveSession(RUNNING), undefined);
  assert.ok(aborts > 0, "the provider was aborted");
  assert.ok(viewer.isClosed(), "the transcript stream was released");
  assert.equal(getSession(RUNNING)!.status, "idle");
  assert.equal(getSession(RUNNING)!.last_message_at, orderedBefore, "the notice does not re-order the session list");
  assert.ok(global.some((event) => event.type === "session:status" && event.sessionId === RUNNING && event.status === "idle"));

  const notice = viewer.live.find((entry) => entry.data.subtype === "reclaimed");
  assert.ok(notice, "an open transcript is told the process is gone");
  assert.equal(notice!.data.reason, "process killed");
  assert.equal(notice!.data.previousStatus, "running");
  assert.match(notice!.data.message, /^Session process ended: process killed\./);

  // The notice outlives the live stream: a reload replays it and shows it.
  assert.equal(notices(RUNNING).length, 1);
  assert.equal(notices(RUNNING)[0]!.seq, notice!.seq);
  const persisted = db.query("SELECT role, content FROM messages WHERE session_id = ? AND seq = ?").get(RUNNING, notice!.seq) as any;
  assert.deepEqual({ role: persisted?.role, content: persisted?.content }, { role: "system", content: notice!.data.message });

  // What the viewer's reducer does with exactly what it was sent.
  let state = reduceEvent(createInitialState(RUNNING), { type: "system", subtype: "init", session_id: RUNNING, model: "m" }, 1);
  assert.equal(state.status, "running");
  for (const entry of viewer.live) state = reduceEvent(state, entry.data, entry.seq);
  assert.equal(state.status, "done", "the transcript settles rather than spinning until reload");

  // An idle session still loses its process and background work, so it says so too.
  const IDLE = "kill-fixture-idle";
  const idle = await startSessionWithMoves({ sessionId: IDLE, cwd, prompt: "finished work" });
  context!.emitEvent({ type: "result", subtype: "success" });
  idle.status = "idle";
  assert.deepEqual(killProcess(IDLE), { ok: true });
  assert.equal(notices(IDLE).length, 1);

  // A session already over has nothing to announce.
  const FINISHED = "kill-fixture-finished";
  const finished = await startSessionWithMoves({ sessionId: FINISHED, cwd, prompt: "already over" });
  finished.status = "done";
  assert.deepEqual(killProcess(FINISHED), { ok: true });
  assert.equal(notices(FINISHED).length, 0);

  // A session the harness no longer holds is an error the widget can report.
  assert.equal(killProcess(RUNNING).ok, false);

  db.close();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
