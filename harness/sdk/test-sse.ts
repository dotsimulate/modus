#!/usr/bin/env bun
/**
 * Layer 2: SSE integration tests for ModusClient.
 *
 * Tests real streaming via fire-and-forget interact() + subscribeEvents().
 * Never uses interact({ subscribe: true }) — that ties the HTTP response
 * to the full session lifecycle and can hang on cold starts.
 *
 * Run with: bun harness/sdk/test-sse.ts
 * Requires a running harness at MODUS_URL (default http://localhost:3777).
 *
 * COST NOTE: Each test creates a real agent session. Prompts are minimal
 * to keep token usage low. Cost summary printed at the end.
 */

import { ModusClient, ModusError, type SessionStatusInfo, type InteractOptions } from "./index";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const URL = process.env.MODUS_URL ?? "http://localhost:3777";
const CWD = process.env.TEST_CWD ?? process.cwd();

// ── Cost tracking ──

type CostEntry = {
  test: string;
  sessionId: string;
  costUsd: number;
  numTurns: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
const costLog: CostEntry[] = [];

async function trackCost(testName: string, sessionId: string) {
  try {
    const status: SessionStatusInfo = await client.getSessionStatus(sessionId);
    costLog.push({
      test: testName,
      sessionId,
      costUsd: status.costUsd ?? 0,
      numTurns: status.numTurns ?? 0,
      inputTokens: (status as any).last_input_tokens ?? null,
      outputTokens: (status as any).last_output_tokens ?? null,
    });
  } catch {
    costLog.push({ test: testName, sessionId, costUsd: 0, numTurns: 0, inputTokens: null, outputTokens: null });
  }
}

function printCostSummary() {
  console.log("\n── Cost Summary ──");
  let totalCost = 0;
  let totalInput = 0;
  let totalOutput = 0;
  for (const e of costLog) {
    const inp = e.inputTokens != null ? String(e.inputTokens) : "?";
    const out = e.outputTokens != null ? String(e.outputTokens) : "?";
    console.log(`  ${e.test}: $${e.costUsd.toFixed(6)} | ${e.numTurns} turns | in:${inp} out:${out} | ${e.sessionId.slice(0, 8)}…`);
    totalCost += e.costUsd;
    if (e.inputTokens != null) totalInput += e.inputTokens;
    if (e.outputTokens != null) totalOutput += e.outputTokens;
  }
  console.log(`  ────`);
  console.log(`  Total: $${totalCost.toFixed(6)} | input:${totalInput} output:${totalOutput} tokens`);
}

// ── Auth ──

function loadPin(): string {
  if (process.env.MODUS_PIN) return process.env.MODUS_PIN;
  const secretsPath = process.env.HARNESS_SECRETS_FILE
    ?? join(homedir(), ".config", "agent-dev-zone", "secrets.env");
  if (existsSync(secretsPath)) {
    const content = readFileSync(secretsPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("HARNESS_PIN=")) {
        let val = trimmed.slice("HARNESS_PIN=".length).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
          val = val.slice(1, -1);
        return val;
      }
    }
  }
  return "";
}

const client = new ModusClient({
  url: URL,
  token: process.env.MODUS_TOKEN || undefined,
  pin: process.env.MODUS_TOKEN ? undefined : loadPin() || undefined,
});

// ── Test harness ──

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (err: any) {
    failed++;
    const msg = err instanceof ModusError ? `${err.status} ${err.detail}` : err.message;
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name} — ${msg} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

// ── Helpers ──

/** Fire-and-forget interact — returns sessionId immediately, never streams. */
async function fireSession(prompt: string): Promise<string> {
  const result = await client.interact({
    prompt,
    permissionMode: "bypass",
    maxTurns: 1,
    cwd: CWD,
    subscribe: false,
  });
  assert(!!result.sessionId, "interact returned no sessionId");
  console.log(`    → session ${result.sessionId.slice(0, 8)}… (${result.status})`);
  return result.sessionId;
}

/** Poll until session reaches idle/done. Hard 90s timeout. */
async function waitForIdle(sessionId: string, timeoutMs = 90_000): Promise<SessionStatusInfo> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.getSessionStatus(sessionId);
    if (status.status === "idle" || status.status === "done") return status;
    if (status.status === "error") throw new Error(`Session errored: ${status.error}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Timed out waiting for idle (${timeoutMs}ms)`);
}

/** Subscribe via callback API with hard timeout. Resolves when onDone/onDisconnect/timeout. */
function subscribeAndCollect(
  sessionId: string,
  afterSeq: number,
  timeoutMs = 90_000,
): Promise<{ events: Array<{ data: any; seq: number }>; doneReason: "server" | "disconnect" | "timeout" | "error" }> {
  return new Promise((resolve) => {
    const events: Array<{ data: any; seq: number }> = [];
    let resolved = false;
    let timer: ReturnType<typeof setTimeout>;
    let unsub: () => void;

    const finish = (reason: "server" | "disconnect" | "timeout" | "error") => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { unsub?.(); } catch {}
      resolve({ events, doneReason: reason });
    };

    timer = setTimeout(() => finish("timeout"), timeoutMs);

    unsub = client.subscribeEvents(sessionId, afterSeq, {
      onEvent: (event, seq) => { events.push({ data: event, seq }); },
      onDone: () => finish("server"),
      onDisconnect: () => finish("disconnect"),
      onError: () => finish("error"),
    });
  });
}

// ════════════════════════════════════════════════════════════════════
console.log("\n═══ Layer 2: SSE Integration Tests ═══\n");
// ════════════════════════════════════════════════════════════════════

// ── Test 1: Fire session, subscribe, verify events arrive ──
console.log("Streaming:");

let testSession1 = "";

await test("fire session + subscribeEvents receives stream events", async () => {
  const sid = await fireSession("Say exactly: SSE_TEST_OK");
  testSession1 = sid;

  // Subscribe from seq 0 to catch everything
  const { events, doneReason } = await subscribeAndCollect(sid, 0);

  assert(events.length > 0, `expected events, got 0 (doneReason: ${doneReason})`);

  // Check we got meaningful event types
  const types = events.map((e) => e.data?.type).filter(Boolean);
  const hasStream = types.includes("stream_event");
  const hasResult = types.includes("result");
  assert(hasStream || hasResult, `expected stream_event or result, got types: ${Array.from(new Set(types)).join(", ")}`);

  await trackCost("stream basic", sid);
});

// ── Test 2: Follow-up message — the exact SSE bug scenario ──
console.log("\nFollow-up messages:");

await test("follow-up message events arrive via SSE", async () => {
  // Create + complete first turn
  const sid = await fireSession("Say exactly: TURN_ONE");
  await waitForIdle(sid);
  console.log(`    → first turn done`);

  // Get current seq so we only collect new events
  const status = await client.getSessionStatus(sid);
  const afterSeq = status.seq;

  // Start SSE subscription BEFORE sending follow-up
  const collecting = subscribeAndCollect(sid, afterSeq);

  // Let SSE connection establish
  await new Promise((r) => setTimeout(r, 800));

  // Send follow-up
  const queueResult = await client.sendMessage(sid, "Say exactly: TURN_TWO");
  console.log(`    → follow-up queued: ${JSON.stringify(queueResult)}`);

  // Wait for events
  const { events, doneReason } = await collecting;

  assert(events.length > 0, `expected follow-up events, got 0 (doneReason: ${doneReason})`);
  assert(doneReason !== "error", `SSE errored`);

  await trackCost("follow-up", sid);
});

// ── Test 3: Rapid follow-up messages ──
console.log("\nRapid messages:");

await test("two follow-ups in sequence both produce events", async () => {
  const sid = await fireSession("Say exactly: RAPID_ONE");
  await waitForIdle(sid);

  const status = await client.getSessionStatus(sid);
  const collecting = subscribeAndCollect(sid, status.seq, 120_000);
  await new Promise((r) => setTimeout(r, 800));

  // First follow-up
  await client.sendMessage(sid, "Say exactly: RAPID_TWO");
  await waitForIdle(sid);
  console.log(`    → second turn done`);

  // Second follow-up
  await client.sendMessage(sid, "Say exactly: RAPID_THREE");
  await waitForIdle(sid);
  console.log(`    → third turn done`);

  // Let SSE flush
  await new Promise((r) => setTimeout(r, 2000));

  const { events, doneReason } = await collecting;
  assert(events.length >= 2, `expected ≥2 events for 2 follow-ups, got ${events.length} (doneReason: ${doneReason})`);

  await trackCost("rapid follow-ups", sid);
});

// ── Test 4: Catch-up replay on completed session ──
console.log("\nCatch-up replay:");

await test("subscribing to completed session replays past events", async () => {
  const sid = testSession1;
  if (!sid) throw new Error("no session from earlier test");

  // Subscribe from 0 — should replay all historical events then close
  const { events, doneReason } = await subscribeAndCollect(sid, 0, 15_000);
  assert(events.length > 0, `expected catch-up events, got 0 (doneReason: ${doneReason})`);
  console.log(`    → replayed ${events.length} events (${doneReason})`);
});

// ── Test 5: onDone vs onDisconnect ──
console.log("\nStream lifecycle:");

await test("onDone fires on clean session completion (not onDisconnect)", async () => {
  const sid = await fireSession("Say exactly: DONE_TEST");

  // Subscribe and wait for natural completion
  const { events, doneReason } = await subscribeAndCollect(sid, 0);

  assert(doneReason === "server", `expected doneReason=server, got ${doneReason}`);
  assert(events.length > 0, "expected events");

  await trackCost("lifecycle", sid);
});

// ════════════════════════════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════════════════════════════

console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
}

printCostSummary();

// Clean up — tag and archive test sessions
const testSessions = Array.from(new Set(costLog.map((e) => e.sessionId).filter(Boolean)));
for (const sid of testSessions) {
  try {
    await client.addTag(sid, "sdk-test");
    await client.archiveSession(sid);
  } catch { /* best effort */ }
}
if (testSessions.length > 0) {
  console.log(`\nCleaned up: archived ${testSessions.length} test session(s) (tagged "sdk-test")`);
}

process.exit(failed > 0 ? 1 : 0);
