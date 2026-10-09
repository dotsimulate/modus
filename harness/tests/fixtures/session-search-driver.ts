import { strict as assert } from "node:assert";
import { db, upsertSession, addEvent, searchSessions, listSessionsScoped, updateSessionTags, indexSessionTitle } from "../../db";

function seed(id: string, time: number, cwd = "/projects/example", userProfile = "example", profile = "helper") {
  upsertSession({ id, preview: id, cwd, userProfile, profile, messageCount: 2, costUsd: 0 });
  db.run("UPDATE sessions SET last_message_at = ? WHERE id = ?", [time, id]);
  addEvent(id, 1, "user", null, JSON.stringify({ message: { content: "authentication setup" } }));
  addEvent(id, 2, "assistant", null, JSON.stringify({ message: { content: [{ type: "text", text: "refactor access token" }] } }));
}
const ids = (query: string, options?: Parameters<typeof searchSessions>[3], limit = 20) => searchSessions(query, limit, undefined, options).map(hit => hit.session_id);

try {
  seed("old", 100);
  seed("new", 300);
  seed("middle", 200);
  seed("archived", 500);
  updateSessionTags("archived", ["archived"]);
  seed("internal", 600);
  updateSessionTags("internal", ["internal"]);
  assert.deepEqual(ids("  REFACTOR\tauth  ", { sort: "latest" }), ["new", "middle", "old"]);
  assert.deepEqual(ids("auth refactor", { sort: "oldest", offset: 1 }, 1), ["middle"]);
  assert.deepEqual(ids("auth refactor", { sort: "latest" }, 1), ["new"]);
  assert.deepEqual(ids('auth "access token"', { sort: "latest" }), ["new", "middle", "old"]);
  assert.deepEqual(ids('"token access"'), []);
  assert.deepEqual(ids('"access tok"'), []);
  assert.deepEqual(ids('"access token'), ids('"access token"'));
  assert.deepEqual(ids("user"), []); // role metadata is not conversation text
  assert.deepEqual(ids("  \"\" * - : () "), []);
  assert.deepEqual(ids("auth nonexistent"), []);
  assert.deepEqual(searchSessions("auth refactor", 20, { role: "user" }), []);
  assert.equal(searchSessions("refactor", 20, { role: "assistant" }).length, 3);
  indexSessionTitle("old", "nebulous topic");
  assert.deepEqual(ids("nebulous refactor"), ["old"]);
  indexSessionTitle("old", "");
  assert.deepEqual(ids("nebulous"), []);
  seed("elsewhere", 700, "/projects/example-other");
  seed("other-profile", 800, "/projects/example", "different");
  seed("other-agent", 900, "/projects/example", "example", "different");
  const scoped = searchSessions("auth refactor", 20, { cwdPrefixes: ["/projects/example"], userProfileName: "example", agentProfiles: ["helper"] }, { sort: "latest" });
  assert.deepEqual(scoped.map(hit => hit.session_id), ["new", "middle", "old"]);
  assert(scoped.every(hit => /auth|refactor/i.test(hit.snippet)));
  // Date bounds are [after, before) on last_message_at, applied before the limit.
  const window = { cwdPrefixes: ["/projects/example"], userProfileName: "example", agentProfiles: ["helper"], lastMessageAfter: 200, lastMessageBefore: 300 };
  assert.deepEqual(searchSessions("auth refactor", 1, window).map(hit => hit.session_id), ["middle"]);
  assert.deepEqual(listSessionsScoped({ ...window, limit: 1 }).map(s => s.id), ["middle"]);
  assert.deepEqual(listSessionsScoped({ ...window, lastMessageBefore: undefined }).map(s => s.id), ["new", "middle"]);
  assert.equal(new Set(ids("auth")).size, ids("auth").length);
  for (let i = 0; i < 25; i++) seed(`page-${String(i).padStart(2, "0")}`, 1000);
  const first = ids("auth", { sort: "latest" });
  const second = ids("auth", { sort: "latest", offset: 20 });
  assert.equal(new Set([...first, ...second]).size, first.length + second.length);
  upsertSession({ id: "rank-title", preview: "rankingprobe", messageCount: 0, costUsd: 0 });
  upsertSession({ id: "rank-body", preview: "", messageCount: 0, costUsd: 0 });
  addEvent("rank-body", 1, "user", null, JSON.stringify({ message: { content: "rankingprobe" } }));
  db.run("UPDATE sessions SET last_message_at = 1000 WHERE id IN ('rank-title', 'rank-body')");
  assert.deepEqual(ids("rankingprobe"), ["rank-title", "rank-body"]);
  console.log("search database assertions passed");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
