// Worker-thread entry. Keep this free of harness/database imports: db.ts opens
// the live database read-write and runs migrations as a side effect of import.
//
// Rebuilding a transcript means reading every event row of a session into JS
// and parsing it — hundreds of milliseconds for one long session, seconds for a
// batch — and full-text ranking over a large index costs the same order. Done
// on the backend's main thread, that stalls every HTTP request and stream until
// it finishes. Here it runs on its own read-only connection; WAL lets it read
// alongside the main thread's writes.
import { Database } from "bun:sqlite";
import { dropToolPayloads, reconstructSessionTurns, type SessionHistoryEventRow } from "./session-history";
import { querySessionSearch } from "./session-search-query";
import type { TurnContent } from "./db";
import type { TranscriptReadReply, TranscriptReadRequest } from "./transcript-read";

declare var self: Worker;

let db: Database | null = null;
let openedPath = "";

function open(dbPath: string): Database {
  if (db && openedPath === dbPath) return db;
  db?.close();
  // Cleared first so an open that throws cannot leave a closed handle cached.
  db = null;
  db = new Database(dbPath, { readonly: true });
  openedPath = dbPath;
  return db;
}

/** Same rows, same order, same reconstruction as db.ts getSessionMessagesFromEvents. */
function readEventTurns(conn: Database, sessionId: string): TurnContent[] {
  const sessionModel = (conn.prepare(`SELECT model FROM sessions WHERE id = $sid`)
    .get({ $sid: sessionId }) as { model: string | null } | null)?.model ?? "";
  const events = conn.prepare(
    `SELECT id, seq, type, subtype, data, created_at FROM events
     WHERE session_id = $sid AND type IN ('user', 'assistant', 'result')
     ORDER BY created_at ASC, id ASC`,
  ).all({ $sid: sessionId }) as SessionHistoryEventRow[];
  return reconstructSessionTurns(events, sessionModel);
}

function answer(request: TranscriptReadRequest): unknown {
  const conn = open(request.dbPath);
  if (request.kind === "search") {
    return querySessionSearch(conn, request.query, request.limit, request.scope, request.options);
  }
  const turns = readEventTurns(conn, request.sessionId);
  if (request.toolPayloads === false) dropToolPayloads(turns);
  return turns;
}

self.onmessage = (event: MessageEvent<TranscriptReadRequest>) => {
  const request = event.data;
  let reply: TranscriptReadReply;
  try {
    reply = { id: request.id, value: answer(request) };
  } catch (error) {
    reply = { id: request.id, error: error instanceof Error ? error.message : String(error) };
  }
  postMessage(reply);
};
