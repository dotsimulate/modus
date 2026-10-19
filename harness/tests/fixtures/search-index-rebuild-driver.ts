import { strict as assert } from "node:assert";
import { db, upsertSession, addEvent, searchSessions, searchSessionsOffThread, searchIndexRebuildPending, startSearchIndexRebuild, renameSession } from "../../db";

// Phase "seed" leaves the database as a v2-era Modus would have: events and
// sessions, a v2 index, and no v3. Phase "upgrade" opens it on this version.
const phase = process.argv[2];
const ids = (query: string) => searchSessions(query, 20).map(hit => hit.session_id).sort();

function seed(id: string, prompt: unknown, reply: string) {
  upsertSession({ id, preview: id, cwd: "/projects/example", userProfile: "example", profile: "helper", messageCount: 2, costUsd: 0 });
  addEvent(id, 1, "user", "prompt", JSON.stringify({ message: { content: prompt } }));
  addEvent(id, 2, "assistant", null, JSON.stringify({ message: { content: [{ type: "text", text: reply }] } }));
  addEvent(id, 3, "user", null, JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t", content: "toolnoise" }] } }));
}

try {
  if (phase === "seed") {
    seed("plain", "plainprompt words", "plainreply");
    seed("blocks", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: "attachedprompt words" }], "blocksreply");
    for (let i = 0; i < 300; i++) seed(`bulk-${i}`, `bulkprompt ${i}`, "bulkreply");
    db.run(`DROP TABLE search_index_v3`);
    db.run(`CREATE VIRTUAL TABLE search_index_v2 USING fts5(session_id UNINDEXED, role, content, title, tokenize = 'porter unicode61', columnsize = 0)`);
    db.run(`INSERT INTO search_index_v2 (session_id, role, content, title) VALUES ('plain', 'user', 'onlyinvtwo', '')`);
  } else if (phase === "upgrade") {
    assert.equal(searchIndexRebuildPending(), true);
    // Until the rebuild is done, search reads v2, on either thread.
    assert.deepEqual(ids("onlyinvtwo"), ["plain"]);
    assert.deepEqual((await searchSessionsOffThread("onlyinvtwo", 20)).map(hit => hit.session_id), ["plain"]);
    // A write during the rebuild reaches both indexes.
    seed("live", "liveprompt", "livereply");
    assert.deepEqual(ids("liveprompt"), ["live"]);
    assert.equal(searchIndexRebuildPending(), true);

    startSearchIndexRebuild();
    const deadline = Date.now() + 20_000;
    while (searchIndexRebuildPending()) {
      assert(Date.now() < deadline, "search index rebuild did not finish");
      await Bun.sleep(25);
    }
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'search_index%' AND type = 'table'`).all() as { name: string }[]).map(t => t.name);
    assert(tables.includes("search_index_v3"));
    assert(!tables.includes("search_index_v2") && !tables.includes("search_index_build"));

    assert.deepEqual(ids("onlyinvtwo"), []);
    assert.deepEqual(ids("plainprompt"), ["plain"]);
    assert.deepEqual(ids("attachedprompt"), ["blocks"]);
    assert.deepEqual(ids("blocksreply"), ["blocks"]);
    assert.deepEqual(ids("liveprompt"), ["live"]);
    assert.deepEqual(ids("toolnoise"), []);
    assert.equal(ids("bulkprompt").length, 20);
    assert.equal(searchSessions("bulkprompt", 200).length, 200);
    assert.deepEqual(ids("blocks"), ["blocks"]); // titles are indexed too
    assert.deepEqual((await searchSessionsOffThread("attachedprompt", 20)).map(hit => hit.session_id), ["blocks"]);
    // Every event was indexed exactly once.
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM search_index_v3 WHERE content = 'bulkreply'`).get() as { n: number }).n;
    assert.equal(rows, 300);

    // A rekeyed session stays searchable under its new id, prompt and title included.
    renameSession("plain", "plain-renamed");
    assert.deepEqual(ids("plainprompt"), ["plain-renamed"]);
    assert.deepEqual(ids("plainreply"), ["plain-renamed"]);
  } else {
    throw new Error(`unknown phase ${phase}`);
  }
  console.log(`search index ${phase} assertions passed`);
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
