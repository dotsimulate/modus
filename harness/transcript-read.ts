/**
 * Off-thread transcript reads. The worker (transcript-read-worker.ts) rebuilds
 * sessions' turns and runs session search on its own read-only connection, so
 * the backend's event loop keeps serving requests, streams, and uploads while
 * an agent researches.
 *
 * A read resolves to `null` whenever no worker can answer it — it would not
 * start, it crashed, or the query failed — and the caller then takes the
 * synchronous path. That is slower for everyone but never a missing answer.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SearchHit, TurnContent } from "./db";
import type { SessionSearchOptions, SessionSearchScope } from "./session-search-query";

export type TranscriptReadQuery =
  | {
      kind: "turns";
      sessionId: string;
      /** `false` empties each tool call's input and drops its result. */
      toolPayloads?: boolean;
    }
  | {
      kind: "search";
      query: string;
      limit?: number;
      scope?: SessionSearchScope;
      options?: SessionSearchOptions;
    };

export type TranscriptReadRequest = TranscriptReadQuery & { id: number; dbPath: string };

export type TranscriptReadReply =
  | { id: number; value: unknown }
  | { id: number; error: string };

/** A worker nobody has used for this long is stopped; the next read starts another. */
const IDLE_MS = 60_000;
/** Worker exits in a row, none of which answered anything, before reads stay on the main thread. */
const MAX_DEAD_STARTS = 3;

let worker: Worker | null = null;
let answered = false;
let deadStarts = 0;
let disabled = false;
let reportedReadError = false;
let nextId = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, (value: unknown) => void>();

function workerPath(): string {
  // Packaged builds ship a bundled .js beside server.js; a source run has the .ts.
  const bundled = join(import.meta.dir, "transcript-read-worker.js");
  return existsSync(bundled) ? bundled : join(import.meta.dir, "transcript-read-worker.ts");
}

function stopWorker(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = worker;
  worker = null;
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  current?.terminate();
}

function onWorkerDied(current: Worker, detail: string): void {
  if (worker !== current) return;
  deadStarts = answered ? 0 : deadStarts + 1;
  if (deadStarts >= MAX_DEAD_STARTS) {
    disabled = true;
    console.error(`[transcript-read] worker failed ${deadStarts} times without answering; reading on the main thread from now on: ${detail}`);
  } else {
    console.error(`[transcript-read] worker stopped; pending reads fall back to the main thread: ${detail}`);
  }
  stopWorker();
}

function ensureWorker(): Worker | null {
  if (disabled) return null;
  if (worker) return worker;
  let created: Worker;
  try {
    created = new Worker(workerPath());
  } catch (error) {
    deadStarts += 1;
    if (deadStarts >= MAX_DEAD_STARTS) disabled = true;
    console.error("[transcript-read] could not start worker:", error);
    return null;
  }
  answered = false;
  created.onmessage = (event: MessageEvent<TranscriptReadReply>) => {
    const reply = event.data;
    const resolve = pending.get(reply.id);
    pending.delete(reply.id);
    answered = true;
    deadStarts = 0;
    if ("error" in reply) {
      if (!reportedReadError) {
        reportedReadError = true;
        console.error(`[transcript-read] off-thread read failed; using the main thread for it: ${reply.error}`);
      }
      resolve?.(null);
    } else {
      resolve?.(reply.value);
    }
    if (pending.size === 0) scheduleIdleStop();
  };
  created.addEventListener("error", (event) => {
    onWorkerDied(created, (event as ErrorEvent).message ?? "error");
  });
  created.addEventListener("close", () => onWorkerDied(created, "exited"));
  // An idle worker must not hold a CLI or test process open.
  created.unref();
  worker = created;
  return created;
}

function scheduleIdleStop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size === 0) stopWorker();
  }, IDLE_MS);
  (idleTimer as { unref?: () => void }).unref?.();
}

function request(dbPath: string, query: TranscriptReadQuery): Promise<unknown> {
  const current = ensureWorker();
  if (!current) return Promise.resolve(null);
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const message: TranscriptReadRequest = { ...query, id, dbPath };
    try {
      current.postMessage(message);
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * Rebuild a session's turns from its event rows on the worker thread. Matches
 * the event path of db.ts getSessionMessages; artifacts and the semantic-row
 * fallback stay with the caller, which owns the read-write connection.
 */
export async function readEventTurnsOffThread(
  dbPath: string,
  sessionId: string,
  options: { toolPayloads?: boolean } = {},
): Promise<TurnContent[] | null> {
  return await request(dbPath, { kind: "turns", sessionId, toolPayloads: options.toolPayloads }) as TurnContent[] | null;
}

/** Run db.ts searchSessions on the worker thread. */
export async function searchOffThread(
  dbPath: string,
  search: { query: string; limit?: number; scope?: SessionSearchScope; options?: SessionSearchOptions },
): Promise<SearchHit[] | null> {
  return await request(dbPath, { kind: "search", ...search }) as SearchHit[] | null;
}

/** Stop the worker now. For tests and shutdown; reads start a new one on demand. */
export function stopTranscriptReadWorker(): void {
  stopWorker();
}
