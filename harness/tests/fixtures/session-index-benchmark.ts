// Synthetic database only. Run with NODE_ENV=test and an isolated MODUS_HOME.
if (process.env.NODE_ENV !== "test" || !process.env.MODUS_HOME) {
  throw new Error("This benchmark requires NODE_ENV=test and an isolated MODUS_HOME");
}
const { Database } = await import("bun:sqlite");
const { resolveDatabasePath } = await import("../../database-paths");
const { listSessionIndex, listSessions, getStoredSessionConfig } = await import("../../db");
const db = new Database(resolveDatabasePath("harness.db"));
const insert = db.prepare(`INSERT INTO sessions (id, preview, status, created_at, updated_at,
  last_message_at, last_prompt, last_response, ui_state, tags) VALUES (?, 'fixture', 'done', 1, 1, ?, ?, ?, ?, '[]')`);
const event = db.prepare("INSERT INTO events(session_id, seq, type, subtype, data, created_at) VALUES (?, ?, ?, ?, ?, 1)");
db.transaction(() => {
  for (let i = 0; i < 10_000; i++) {
    const id = `bench-${i}`;
    insert.run(id, i, "p".repeat(80), "r".repeat(500), "u".repeat(3000));
    if (i >= 9750) {
      event.run(id, 0, "system", "init", '{"provider":"fixture"}');
      for (let seq = 1; seq <= 200; seq++) event.run(id, seq, "assistant", null, "{}");
    }
  }
})();

function measure(read: () => unknown) {
  const samples: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    const rows = read();
    samples.push(performance.now() - start);
    bytes = Buffer.byteLength(JSON.stringify(rows));
  }
  samples.sort((a, b) => a - b);
  return { medianMs: Number(samples[6]!.toFixed(2)), bytes };
}
const legacyRead = () => listSessions(250).map((row) => ({ ...row, provider: getStoredSessionConfig(row.id)?.provider }));
const indexRead = () => listSessionIndex(250).map((row) => ({ ...row, provider: getStoredSessionConfig(row.id)?.provider }));
const optimized = measure(indexRead);
db.run("DROP INDEX idx_sessions_visible_activity");
db.run("DROP INDEX idx_events_session_config");
const original = measure(legacyRead);
console.log(JSON.stringify({ sessions: 10_000, events: 50_250, original, optimized }));
db.close();
process.exit(0);
