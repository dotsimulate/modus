#!/usr/bin/env bun
/**
 * Layer 1: Endpoint contract tests for ModusClient.
 * Run with: bun harness/sdk/test-sdk.ts
 * Requires a running harness at MODUS_URL (default http://localhost:3777).
 */

import { ModusClient, ModusError } from "./client";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const URL = process.env.MODUS_URL ?? "http://localhost:3777";
const CWD = process.env.TEST_CWD ?? process.cwd();

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

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err instanceof ModusError ? `${err.status} ${err.detail}` : err.message;
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name} — ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertKeys(obj: any, keys: string[], label: string) {
  for (const k of keys) {
    assert(k in obj, `${label} missing key "${k}"`);
  }
}

console.log("\n═══ ModusClient SDK Contract Tests ═══\n");

// ── Sessions ──
console.log("Sessions:");

let testSessionId = "";

await test("listSessions", async () => {
  const sessions = await client.listSessions({ limit: 5 });
  assert(Array.isArray(sessions), "expected array");
});

await test("getActiveSessions", async () => {
  const active = await client.getActiveSessions();
  assert(Array.isArray(active), "expected array");
});

await test("searchSessions", async () => {
  const results = await client.searchSessions("test", { limit: 5 });
  assert(Array.isArray(results), "expected array");
});

await test("listArchivedSessions", async () => {
  const archived = await client.listArchivedSessions(5);
  assert(Array.isArray(archived), "expected array");
});

// Create a session for further tests
await test("interact (fire-and-forget)", async () => {
  const result = await client.interact({
    prompt: "Say exactly: SDK_TEST_OK",
    permissionMode: "bypass",
    cwd: CWD,
  });
  assertKeys(result, ["sessionId", "status"], "InteractResult");
  testSessionId = result.sessionId;
});

if (testSessionId) {
  await test("getSessionStatus", async () => {
    const status = await client.getSessionStatus(testSessionId);
    assertKeys(status, ["sessionId", "status"], "SessionStatusInfo");
  });

  await test("getTags", async () => {
    const tags = await client.getTags(testSessionId);
    assert(Array.isArray(tags), "expected array");
  });

  await test("addTag", async () => {
    const result = await client.addTag(testSessionId, "sdk-test");
    assert(Array.isArray(result.tags), "expected tags array");
    assert(result.tags.includes("sdk-test"), "tag should be present");
  });

  await test("removeTag", async () => {
    const result = await client.removeTag(testSessionId, "sdk-test");
    assert(!result.tags.includes("sdk-test"), "tag should be removed");
  });

  await test("getSessionByTag (404 expected)", async () => {
    try {
      await client.getSessionByTag("nonexistent-tag-" + Date.now());
      throw new Error("should have thrown");
    } catch (err) {
      assert(err instanceof ModusError && err.status === 404, "expected 404");
    }
  });

  await test("steerSession", async () => {
    const result = await client.steerSession(testSessionId, "Continue");
    assertKeys(result, ["ok"], "steer result");
  });

  await test("updateTitle", async () => {
    await client.updateTitle(testSessionId, "SDK Test Session");
  });

  await test("archiveSession + unarchiveSession", async () => {
    await client.archiveSession(testSessionId);
    await client.unarchiveSession(testSessionId);
  });
}

// ── Profiles ──
console.log("\nProfiles:");

await test("listProfiles", async () => {
  const profiles = await client.listProfiles(CWD);
  assert(Array.isArray(profiles), "expected array");
  if (profiles.length > 0) assertKeys(profiles[0], ["name"], "Profile");
});

await test("getGlobalConfig", async () => {
  const config = await client.getGlobalConfig(CWD);
  assert(typeof config === "object", "expected object");
});

await test("listUserProfiles", async () => {
  const profiles = await client.listUserProfiles();
  assert(Array.isArray(profiles), "expected array");
});

// ── Providers ──
console.log("\nProviders:");

await test("listProviders", async () => {
  const providers = await client.listProviders();
  assert(Array.isArray(providers), "expected array");
});

await test("getProviderCapabilities", async () => {
  const caps = await client.getProviderCapabilities();
  assert(Array.isArray(caps), "expected array");
});

await test("getProviderHealth", async () => {
  const health = await client.getProviderHealth();
  assert(Array.isArray(health), "expected array");
});

// ── Actions ──
console.log("\nActions:");

await test("listActions", async () => {
  const actions = await client.listActions();
  assert(Array.isArray(actions), "expected array");
});

await test("reloadActions", async () => {
  const result = await client.reloadActions();
  assertKeys(result, ["ok", "count"], "reload result");
});

// ── Moves ──
console.log("\nMoves:");

await test("listMoves", async () => {
  const moves = await client.listMoves(CWD);
  assert(Array.isArray(moves), "expected array");
});

await test("getWidgetUrl", () => {
  const url = client.getWidgetUrl("test-move", CWD);
  assert(url.includes("/api/moves/"), "expected URL");
  return Promise.resolve();
});

await test("getWidgetCssUrl", () => {
  const url = client.getWidgetCssUrl("test-move", CWD);
  assert(url.includes("/widget.css"), "expected CSS URL");
  return Promise.resolve();
});

// ── Missions ──
console.log("\nMissions:");

await test("listMissions", async () => {
  const missions = await client.listMissions(CWD);
  assert(Array.isArray(missions), "expected array");
});

await test("listMissionRuns", async () => {
  const runs = await client.listMissionRuns({ cwd: CWD, limit: 5 });
  assert(Array.isArray(runs), "expected array");
});

// ── Infrastructure ──
console.log("\nInfrastructure:");

await test("gitStatus", async () => {
  const status = await client.gitStatus(CWD);
  assert(typeof status === "object", "expected object");
});

await test("gitLog", async () => {
  const log = await client.gitLog(CWD, 5);
  assert(Array.isArray(log), "expected array");
  if (log.length > 0) assertKeys(log[0], ["hash", "message"], "GitLogEntry");
});

await test("browse", async () => {
  const result = await client.browse(CWD, { includeFiles: true });
  assertKeys(result, ["path", "dirs"], "BrowseResult");
});

await test("queryMemories", async () => {
  const mems = await client.queryMemories({ cwd: CWD });
  assert(Array.isArray(mems), "expected array");
});

await test("listPrompts", async () => {
  const prompts = await client.listPrompts({ projectCwd: CWD });
  assert(Array.isArray(prompts), "expected array");
});

await test("getActivity", async () => {
  const entries = await client.getActivity({ limit: 5 });
  assert(Array.isArray(entries), "expected array");
});

await test("getActivitySummary", async () => {
  const summary = await client.getActivitySummary();
  assert(typeof summary === "object", "expected object");
});

await test("getSessionStats", async () => {
  const stats = await client.getSessionStats();
  assert(typeof stats === "object", "expected object");
});

await test("listNotes", async () => {
  const notes = await client.listNotes(CWD);
  assert(Array.isArray(notes), "expected array");
});

// ── Terminals ──
console.log("\nTerminals:");

let testTerminalId = "";

await test("createTerminal", async () => {
  const term = await client.createTerminal({ cwd: CWD });
  assertKeys(term, ["id"], "TerminalInfo");
  testTerminalId = term.id;
});

await test("listTerminals", async () => {
  const terms = await client.listTerminals();
  assert(Array.isArray(terms), "expected array");
});

if (testTerminalId) {
  await test("getTerminal", async () => {
    const term = await client.getTerminal(testTerminalId);
    assert(term.id === testTerminalId, "id mismatch");
  });

  await test("resizeTerminal", async () => {
    await client.resizeTerminal(testTerminalId, 120, 40);
  });

  await test("deleteTerminal", async () => {
    await client.deleteTerminal(testTerminalId);
  });
}

// ── Trace / Touches ──
console.log("\nTrace:");

await test("fetchTouches", async () => {
  const result = await client.fetchTouches({ limit: 5 });
  assertKeys(result, ["touches"], "TouchesResponse");
  assert(Array.isArray(result.touches), "expected touches array");
});

// ── Projects / Init ──
console.log("\nProjects:");

await test("getInitStatus", async () => {
  const status = await client.getInitStatus(CWD);
  assert(typeof status === "object", "expected object");
});

await test("listProjects", async () => {
  const projects = await client.listProjects();
  assert(Array.isArray(projects), "expected array");
});

// ── Web Positions ──
console.log("\nWeb Positions:");

await test("getWebPositions", async () => {
  const positions = await client.getWebPositions("test-scope");
  assert(Array.isArray(positions), "expected array");
});

await test("patchWebPositions", async () => {
  await client.patchWebPositions("test-scope", [{ nodeId: "test-node", x: 100, y: 200, pinned: true }]);
});

// ── Draft / UI State ──
console.log("\nUI State:");

if (testSessionId) {
  await test("saveDraft + getDraft", async () => {
    await client.saveDraft(testSessionId, "test draft content");
    const draft = await client.getDraft(testSessionId);
    assert(draft === "test draft content", `expected draft content, got "${draft}"`);
    await client.saveDraft(testSessionId, ""); // cleanup
  });

  await test("saveSessionUiState + getSessionUiState", async () => {
    await client.saveSessionUiState(testSessionId, { testKey: "testValue" });
    const state = await client.getSessionUiState(testSessionId);
    assert(typeof state === "object", "expected object");
  });
}

// ── Auth (read-only) ──
console.log("\nAuth:");

await test("authStatus", async () => {
  const status = await client.authStatus();
  assertKeys(status, ["required"], "AuthStatus");
});

await test("healthCheck", async () => {
  const health = await client.healthCheck();
  assertKeys(health, ["status", "uptime"], "HealthCheck");
});

// ── Files ──
console.log("\nFiles:");

await test("browse (with files)", async () => {
  const result = await client.browse(CWD, { includeFiles: true });
  assertKeys(result, ["path", "dirs"], "BrowseResult");
});

// ── Analytics ──
console.log("\nAnalytics:");

await test("getAccountInfo", async () => {
  const info = await client.getAccountInfo();
  assert(typeof info === "object", "expected object");
});

// ── ModusError ──
console.log("\nError handling:");

await test("ModusError on 404", async () => {
  try {
    await client.getProfile("nonexistent-profile-" + Date.now());
    throw new Error("should have thrown");
  } catch (err) {
    assert(err instanceof ModusError, "expected ModusError");
    assert(err.status === 404, `expected 404, got ${(err as ModusError).status}`);
  }
});

// ── Summary ──
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
