import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { resolveDatabasePath } from "../database-paths";
import { getSession, getStoredSessionConfig, listSessionIndex, listSessions, upsertSession, updateSessionTags } from "../db";

test("the index bounds previews, preserves visibility/read state, and excludes saved UI data", () => {
  const id = `index-${crypto.randomUUID()}`;
  upsertSession({ id, preview: "index fixture", messageCount: 2, costUsd: 1,
    lastPrompt: "p".repeat(1000), lastResponse: "r".repeat(2000) });
  const connection = new Database(resolveDatabasePath("harness.db"));
  try {
    connection.query("UPDATE sessions SET ui_state = ?, draft_text = ?, last_reply_seq = 20, read_reply_seq = 10 WHERE id = ?")
      .run("x".repeat(50_000), "private draft", id);
    const row = listSessionIndex(1000).find((session) => session.id === id)!;
    expect(row.last_prompt).toHaveLength(320);
    expect(row.last_response).toHaveLength(320);
    expect(row.last_reply_seq).toBe(20);
    expect(row.read_reply_seq).toBe(10);
    expect(row).not.toHaveProperty("ui_state");
    expect(row).not.toHaveProperty("draft_text");
    expect(getSession(id)!.last_response).toHaveLength(2000);
    expect(listSessions(1000).find((session) => session.id === id)!.last_prompt).toHaveLength(1000);
    updateSessionTags(id, ["internal"]);
    expect(listSessionIndex(1000).some((session) => session.id === id)).toBe(false);
    updateSessionTags(id, ["archived"]);
    expect(listSessionIndex(1000).some((session) => session.id === id)).toBe(false);
  } finally { connection.close(); }
});

test("session ordering and legacy config lookup use their matching partial indexes", () => {
  const connection = new Database(resolveDatabasePath("harness.db"));
  try {
    const plan = JSON.stringify(connection.query(`EXPLAIN QUERY PLAN SELECT * FROM sessions
      WHERE tags NOT LIKE '%"archived"%' AND tags NOT LIKE '%"internal"%'
      ORDER BY last_message_at DESC LIMIT 250`).all());
    expect(plan).toContain("idx_sessions_visible_activity");
    expect(plan).not.toContain("TEMP B-TREE");
    const configPlan = JSON.stringify(connection.query(`EXPLAIN QUERY PLAN SELECT * FROM events
      WHERE session_id = 'fixture' AND type = 'system' AND (subtype = 'config_updated' OR subtype = 'init')
      ORDER BY seq DESC LIMIT 1`).all());
    expect(configPlan).toContain("idx_events_session_config");

    const id = `index-config-${crypto.randomUUID()}`;
    upsertSession({ id, preview: "legacy config fixture", messageCount: 0, costUsd: 0 });
    const insert = connection.query("INSERT INTO events(session_id, seq, type, subtype, data, created_at) VALUES (?, ?, ?, ?, ?, 1)");
    insert.run(id, 1, "system", "init", JSON.stringify({ provider: "old" }));
    insert.run(id, 2, "system", "config_updated", JSON.stringify({ config: { provider: "new" } }));
    insert.run(id, 3, "assistant", null, "{}");
    expect(getStoredSessionConfig(id)?.provider).toBe("new");
  } finally { connection.close(); }
});
