import { strict as assert } from "node:assert";
import { db, upsertSession, addEvent, getSession, getSessionMessages } from "../../db";
import { handlers } from "../../moves/session-research/context";
import type { MoveApiContext } from "../../move-types";

const EVENING_EDT = Date.parse("2026-10-09T01:15:00Z"); // 2026-10-08 21:15 in New York
const PREVIOUS_NIGHT_EDT = Date.parse("2026-10-08T03:00:00Z"); // 2026-10-07 23:00 in New York
const LONG_NARRATION = "detail ".repeat(600);

function session(id: string, opts: { cwd?: string; at?: number } = {}) {
  upsertSession({ id, preview: id, title: `title ${id}`, cwd: opts.cwd ?? "/projects/demo", userProfile: "demo", profile: "helper", messageCount: 0, costUsd: 0 });
}
function user(id: string, seq: number, text: string) {
  addEvent(id, seq, "user", "prompt", JSON.stringify({ message: { content: [{ type: "text", text }] } }));
}
function assistant(id: string, seq: number, final: string, opts: { narration?: string } = {}) {
  let next = seq;
  if (opts.narration) {
    addEvent(id, next++, "assistant", "message", JSON.stringify({ message: { content: [
      { type: "text", text: opts.narration },
      { type: "tool_use", id: `tool-${id}`, name: "Read", input: { file_path: "a.ts" } },
    ] } }));
    addEvent(id, next++, "user", "message", JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: `tool-${id}`, content: "ok" }] } }));
  }
  addEvent(id, next++, "assistant", "message", JSON.stringify({ message: { content: [{ type: "text", text: final }] } }));
  addEvent(id, next++, "result", "success", JSON.stringify({ subtype: "success" }));
}

const ctx = { sessionId: "caller", db: { getSession, getSessionMessages } } as unknown as MoveApiContext;
async function call(op: string, data: Record<string, unknown>): Promise<string> {
  const result = await handlers[op]!(ctx, data) as { ok: boolean; message?: string; error?: string };
  assert.equal(result.ok, true, result.error);
  return result.message ?? "";
}

try {
  session("caller");
  session("asks");
  user("asks", 1, "fix the parser");
  assistant("asks", 2, `${LONG_NARRATION}\nFixed and tested. Want me to commit?`, { narration: "Looking at the parser first." });
  session("external");
  user("external", 1, "ship the build");
  assistant("external", 2, "Started the release build. I'll keep watching it in the background.");
  session("done");
  user("done", 1, "tidy the docs");
  assistant("done", 2, "Docs tidied and committed.");
  session("working");
  user("working", 1, "refactor the lexer");
  assistant("working", 2, "Should I also rename it?");
  session("unanswered");
  user("unanswered", 1, "one more thing about the parser");
  session("empty");
  session("yesterday");
  user("yesterday", 1, "late night parser idea");
  assistant("yesterday", 2, "Noted.");
  session("elsewhere", { cwd: "/projects/other" });
  user("elsewhere", 1, "parser elsewhere");
  db.run("UPDATE sessions SET last_message_at = ?, created_at = ?", [EVENING_EDT, EVENING_EDT - 3_600_000]);
  db.run("UPDATE sessions SET last_message_at = ? WHERE id = 'yesterday'", [PREVIOUS_NIGHT_EDT]);
  db.run("UPDATE sessions SET last_message_at = 1 WHERE id = 'caller'");
  db.run("UPDATE sessions SET status = 'idle'");
  db.run("UPDATE sessions SET status = 'running' WHERE id = 'working'");

  // digest: one local day, endings guessed, final answers kept to the end.
  const digest = await call("digest", { date: "2026-10-08", timeZone: "America/New_York" });
  for (const id of ["asks", "external", "done", "working", "unanswered"]) assert.match(digest, new RegExp(`\\*\\*${id}\\*\\*`));
  for (const id of ["empty", "yesterday", "elsewhere", "caller"]) assert.doesNotMatch(digest, new RegExp(`\\*\\*${id}\\*\\*`));
  const block = (id: string) => digest.split("--- ").find(b => b.startsWith(`**${id}**`)) ?? "";
  assert.match(block("asks"), /Ending \(guess\): asks_user/);
  assert.match(block("asks"), /Want me to commit\?/);
  assert.match(block("asks"), /chars omitted/);
  assert.doesNotMatch(block("asks"), /Looking at the parser first/);
  assert.match(block("external"), /Ending \(guess\): waiting_on_external/);
  assert.match(block("done"), /Ending \(guess\): signed_off/);
  assert.match(block("working"), /Last spoke: assistant \| Ending \(guess\): mid_work/);
  assert.match(block("unanswered"), /Last spoke: user \| Ending \(guess\): mid_work/);
  assert.match(block("asks"), /2026-10-08 20:15 → 2026-10-08 21:15/);
  assert.match(digest, /asks_user 1, waiting_on_external 1, signed_off 1, mid_work 2/);

  // The same calendar date in UTC reaches the previous New York evening.
  const utc = await call("digest", { date: "2026-10-08", timeZone: "UTC" });
  assert.match(utc, /\*\*yesterday\*\*/);
  assert.doesNotMatch(utc, /\*\*asks\*\*/);

  // tail and read reach the end; counts agree across ops.
  const tail = await call("tail", { sessionId: "asks", timeZone: "America/New_York" });
  assert.match(tail, /2 turns/);
  assert.match(tail, /\(final answer\)\n/);
  assert.match(tail, /Want me to commit\?/);
  assert.doesNotMatch(tail, /Looking at the parser first/);
  assert.match(await call("tail", { sessionId: "asks", full: true }), /Looking at the parser first/);
  assert.match(await call("read", { sessionId: "asks", offset: -1 }), /Showing turns 2–2 of 2/);
  assert.match(await call("read", { sessionId: "asks", maxLength: 500 }), /Want me to commit\?/);
  assert.match(await call("info", { sessionId: "asks" }), /Turns: 2/);

  // list: date window, empty sessions hidden unless asked for, turn counts shown.
  const list = await call("list", { date: "2026-10-08", timeZone: "America/New_York" });
  assert.match(list, /\*\*asks\*\* \[helper\] \S+ 2026-10-08 21:15 2 turns/);
  assert.doesNotMatch(list, /\*\*empty\*\*/);
  assert.doesNotMatch(list, /\*\*yesterday\*\*/);
  assert.match(await call("list", { date: "2026-10-08", timeZone: "America/New_York", includeEmpty: true }), /\*\*empty\*\*/);

  // search: falls back to partial matches and labels them.
  const search = await call("search", { query: "parser zebrafish" });
  assert.match(search, /match some of the words/);
  assert.match(search, /\*\*asks\*\*.*matches 1 of 2 words/);
  assert.doesNotMatch(search, /\*\*elsewhere\*\*/);
  const exact = await call("search", { query: "parser", date: "2026-10-08", timeZone: "America/New_York" });
  assert.doesNotMatch(exact, /match some of the words/);
  assert.doesNotMatch(exact, /\*\*yesterday\*\*/);

  // scan from the end shows final answers.
  const scan = await call("scan", { sessionIds: ["asks"], from: "end" });
  assert.match(scan, /last 3 turns/);
  assert.match(scan, /Want me to commit\?/);

  console.log("session research assertions passed");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
