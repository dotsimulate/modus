/**
 * Taking over provider conversations started outside Modus.
 *
 * These pin what the listing offers, what an import turns into, and — the part
 * that is easy to get wrong — that the imported history survives the session's
 * first real turn. History reconstructs from events once any assistant event
 * exists, so an import that wrote only message rows would vanish then.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addEvent, getMaxSeq, getSession, getSessionMessageHistory, getStoredSessionConfig } from "../db";
import { importExternalSession, knownProviderSessions } from "../external-session-import";
import {
  claudeProjectDirName,
  cleanExternalCwd,
  listExternalSessions,
  parseClaudeTranscript,
  parseCodexTranscript,
  type ExternalSessionRoots,
} from "../external-sessions";

const temp = mkdtempSync(join(tmpdir(), "modus-external-sessions-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

function claudeRecords(cwd: string, opts: { title?: string; aiTitle?: string } = {}) {
  const base = { cwd, sessionId: "s", isSidechain: false, entrypoint: "cli" };
  return [
    { ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "fix the build" } },
    { ...base, type: "user", uuid: "m1", parentUuid: "u1", isMeta: true, timestamp: "2026-10-01T10:00:00.500Z", message: { role: "user", content: "<system-reminder>injected</system-reminder>" } },
    { ...base, type: "assistant", uuid: "a1", parentUuid: "m1", timestamp: "2026-10-01T10:00:01.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Looking first." }] } },
    { ...base, type: "assistant", uuid: "a2", parentUuid: "a1", timestamp: "2026-10-01T10:00:02.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
    { ...base, type: "user", uuid: "r1", parentUuid: "a2", timestamp: "2026-10-01T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { ...base, type: "assistant", uuid: "a3", parentUuid: "r1", timestamp: "2026-10-01T10:00:04.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Build fixed." }] } },
    // A sub-agent's traffic is part of the file but not the conversation.
    { ...base, type: "user", uuid: "sc1", parentUuid: "a3", isSidechain: true, timestamp: "2026-10-01T10:00:04.500Z", message: { role: "user", content: "sidechain prompt" } },
    // An abandoned branch: rewound away from, so --resume no longer loads it.
    { ...base, type: "user", uuid: "x1", parentUuid: "a3", timestamp: "2026-10-01T10:00:05.000Z", message: { role: "user", content: "abandoned question" } },
    { ...base, type: "assistant", uuid: "x2", parentUuid: "x1", timestamp: "2026-10-01T10:00:06.000Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] } },
    { ...base, type: "user", uuid: "u2", parentUuid: "a3", timestamp: "2026-10-01T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "now add a test" }] } },
    { ...base, type: "user", uuid: "c1", parentUuid: "u2", timestamp: "2026-10-01T10:01:00.500Z", message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { ...base, type: "assistant", uuid: "a4", parentUuid: "c1", timestamp: "2026-10-01T10:01:05.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "Test added." }] } },
    ...(opts.aiTitle ? [{ type: "ai-title", aiTitle: opts.aiTitle, sessionId: "s" }] : []),
    ...(opts.title ? [{ type: "custom-title", customTitle: opts.title, sessionId: "s" }] : []),
  ];
}

describe("Claude Code transcripts", () => {
  test("keep typed prompts and the reply after the last tool call, on the active branch only", () => {
    const transcript = parseClaudeTranscript("abc", jsonl(claudeRecords("/work/app")));
    expect(transcript.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "fix the build"],
      ["assistant", "Build fixed."],
      ["user", "now add a test"],
      ["assistant", "Test added."],
    ]);
    expect(transcript.cwd).toBe("/work/app");
    expect(transcript.model).toBe("claude-test");
    expect(transcript.turns[0]!.timestamp).toBe(Date.parse("2026-10-01T10:00:00.000Z"));
  });

  test("a user-set title beats a generated one, which beats the first prompt", () => {
    expect(parseClaudeTranscript("a", jsonl(claudeRecords("/w", { aiTitle: "Generated", title: "Mine" }))).title).toBe("Mine");
    expect(parseClaudeTranscript("a", jsonl(claudeRecords("/w", { aiTitle: "Generated" }))).title).toBe("Generated");
    expect(parseClaudeTranscript("a", jsonl(claudeRecords("/w"))).title).toBe("fix the build");
  });

  test("a compacted conversation is followed across its logical parent", () => {
    const records = [
      { type: "user", uuid: "u1", parentUuid: null, cwd: "/w", message: { content: "before compaction" } },
      { type: "assistant", uuid: "a1", parentUuid: "u1", message: { content: [{ type: "text", text: "early reply" }] } },
      { type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a1" },
      { type: "user", uuid: "s1", parentUuid: "b1", isCompactSummary: true, message: { content: "summary of earlier" } },
      { type: "user", uuid: "u2", parentUuid: "s1", message: { content: "after compaction" } },
      { type: "assistant", uuid: "a2", parentUuid: "u2", message: { content: [{ type: "text", text: "late reply" }] } },
    ];
    expect(parseClaudeTranscript("c", jsonl(records)).turns.map((turn) => turn.text)).toEqual([
      "before compaction", "early reply", "after compaction", "late reply",
    ]);
  });
});

describe("Codex transcripts", () => {
  test("skip injected context and keep the final reply of each turn", () => {
    const rollout = jsonl([
      { type: "session_meta", payload: { cwd: "\\\\?\\D:\\work\\app" } },
      { type: "response_item", timestamp: "2026-10-02T09:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for D:\\work" }] } },
      { type: "response_item", timestamp: "2026-10-02T09:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "rename the module" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking usages." }] } },
      { type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } },
      { type: "response_item", payload: { type: "function_call_output", output: "done" } },
      { type: "response_item", timestamp: "2026-10-02T09:00:09.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Renamed." }] } },
    ]);
    const transcript = parseCodexTranscript("t1", rollout);
    expect(transcript.cwd).toBe("D:\\work\\app");
    expect(transcript.turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "rename the module"],
      ["assistant", "Renamed."],
    ]);
  });

  test("the Windows long-path prefix is removed from recorded folders", () => {
    expect(cleanExternalCwd("\\\\?\\C:\\a\\b")).toBe("C:\\a\\b");
    expect(cleanExternalCwd("/home/me/app")).toBe("/home/me/app");
    expect(cleanExternalCwd("")).toBeNull();
  });
});

// ── Listing and import against stores on disk ──

const projectA = join(temp, "work", "app");
const projectB = join(temp, "other", "tool");
mkdirSync(projectA, { recursive: true });
mkdirSync(projectB, { recursive: true });

const roots: ExternalSessionRoots = {
  claudeProjects: join(temp, "claude-projects"),
  codexHome: join(temp, "codex-home"),
};

function writeClaudeSession(id: string, cwd: string, records: unknown[]) {
  const dir = join(roots.claudeProjects, claudeProjectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), jsonl(records));
}

const CLAUDE_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const CLAUDE_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const CLAUDE_STUB = "33333333-cccc-4ccc-8ccc-333333333333";
writeClaudeSession(CLAUDE_A, projectA, claudeRecords(projectA, { title: "Build fixes" }));
writeClaudeSession(CLAUDE_B, projectB, claudeRecords(projectB, { title: "Tooling" }));
// An aborted start with no typed prompt is not a conversation to offer.
writeClaudeSession(CLAUDE_STUB, projectA, [{ type: "queue-operation", operation: "enqueue", sessionId: CLAUDE_STUB }]);

describe("listing Claude Code sessions", () => {
  test("lists conversations with a prompt, titled, and skips stubs", async () => {
    const sessions = await listExternalSessions({ provider: "claude-code", roots });
    expect(sessions.map((s) => s.id).sort()).toEqual([CLAUDE_A, CLAUDE_B].sort());
    expect(sessions.find((s) => s.id === CLAUDE_A)).toMatchObject({ title: "Build fixes", cwd: projectA, source: "cli" });
  });

  test("filters by folder and by search text", async () => {
    const inA = await listExternalSessions({ provider: "claude-code", roots, cwd: projectA });
    expect(inA.map((s) => s.id)).toEqual([CLAUDE_A]);
    const searched = await listExternalSessions({ provider: "claude-code", roots, query: "tooling" });
    expect(searched.map((s) => s.id)).toEqual([CLAUDE_B]);
  });

  test("marks or hides conversations Modus already holds", async () => {
    const knownSessions = new Map([[CLAUDE_B, "modus-session-b"]]);
    const marked = await listExternalSessions({ provider: "claude-code", roots, knownSessions });
    expect(marked.find((s) => s.id === CLAUDE_B)?.modusSessionId).toBe("modus-session-b");
    const hidden = await listExternalSessions({ provider: "claude-code", roots, knownSessions, hideKnown: true });
    expect(hidden.map((s) => s.id)).toEqual([CLAUDE_A]);
  });

  test("a missing store lists nothing rather than failing", async () => {
    const empty = { claudeProjects: join(temp, "absent"), codexHome: join(temp, "absent") };
    expect(await listExternalSessions({ provider: "claude-code", roots: empty })).toEqual([]);
    expect(await listExternalSessions({ provider: "codex", roots: empty })).toEqual([]);
  });
});

const CODEX_MINE = "019a0000-0000-7000-8000-000000000001";
const CODEX_MODUS = "019a0000-0000-7000-8000-000000000002";
const CODEX_SUBAGENT = "019a0000-0000-7000-8000-000000000003";
{
  mkdirSync(roots.codexHome, { recursive: true });
  const rollout = join(roots.codexHome, "rollout-mine.jsonl");
  writeFileSync(rollout, jsonl([
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "speed up the query" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Indexed it." }] } },
  ]));
  const state = new Database(join(roots.codexHome, "state_5.sqlite"));
  state.run(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    first_user_message TEXT NOT NULL DEFAULT '', model TEXT, updated_at_ms INTEGER, thread_source TEXT,
    preview TEXT NOT NULL DEFAULT '', name TEXT, originator TEXT
  )`);
  const insert = state.prepare(`INSERT INTO threads (id, rollout_path, created_at, updated_at, source, cwd, title, model, updated_at_ms, thread_source, originator)
    VALUES (?, ?, 0, 1, ?, ?, ?, 'gpt-test', ?, ?, ?)`);
  insert.run(CODEX_MINE, rollout, "cli", `\\\\?\\${projectB}`, "Query speed", 3000, "user", null);
  insert.run(CODEX_MODUS, rollout, "vscode", projectB, "Started by Modus", 2000, null, "modus_harness");
  insert.run(CODEX_SUBAGENT, rollout, "{\"subagent\":{}}", projectB, "Worker", 1000, "subagent", null);
  // A live statement defers close, and an open handle blocks removing the temp dir on Windows.
  insert.finalize();
  state.close();
}

describe("listing Codex sessions", () => {
  test("offers threads a person started, not Modus's own or sub-agents", async () => {
    const sessions = await listExternalSessions({ provider: "codex", roots });
    expect(sessions.map((s) => s.id)).toEqual([CODEX_MINE]);
    expect(sessions[0]).toMatchObject({ title: "Query speed", cwd: projectB, source: "cli", updatedAt: 3000 });
  });
});

describe("importing", () => {
  test("creates a resumable session whose history survives new turns", () => {
    const result = importExternalSession({ provider: "claude-code", id: CLAUDE_A, roots, userProfile: "tester" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.existing).toBe(false);

    const row = getSession(result.sessionId)!;
    expect(row.provider).toBe("claude-code");
    expect(row.provider_session_id).toBe(CLAUDE_A);
    expect(row.cwd).toBe(projectA);
    expect(row.title).toBe("Build fixes");
    expect(row.user_profile).toBe("tester");
    // Non-zero message count is what makes the provider resume rather than start fresh.
    expect(row.message_count).toBe(4);

    // A revived session reads its provider from the stored config, not the profile.
    expect(getStoredSessionConfig(result.sessionId)).toMatchObject({ provider: "claude-code", model: "claude-test", cwd: projectA });

    const imported = ["fix the build", "Build fixed.", "now add a test", "Test added."];
    const before = getSessionMessageHistory(result.sessionId, { preserveEventSequence: true }).messages;
    expect(before.map((turn) => turn.text)).toEqual(imported);

    // The first turn run through Modus appends provider events after the import.
    const now = Date.now();
    let seq = getMaxSeq(result.sessionId);
    addEvent(result.sessionId, ++seq, "user", "prompt", JSON.stringify({ type: "user", subtype: "prompt", message: { content: "and the docs" } }), now);
    addEvent(result.sessionId, ++seq, "assistant", null, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Docs updated." }] } }), now + 1);
    addEvent(result.sessionId, ++seq, "result", "success", JSON.stringify({ type: "result", subtype: "success" }), now + 2);

    for (const preserveEventSequence of [true, false]) {
      const after = getSessionMessageHistory(result.sessionId, { preserveEventSequence }).messages;
      expect(after.map((turn) => turn.text)).toEqual([...imported, "and the docs", "Docs updated."]);
    }
  });

  test("importing the same conversation again returns the existing session", () => {
    const first = importExternalSession({ provider: "codex", id: CODEX_MINE, roots });
    const second = importExternalSession({ provider: "codex", id: CODEX_MINE, roots });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second).toEqual({ ok: true, sessionId: first.sessionId, existing: true });
    expect(knownProviderSessions().get(CODEX_MINE)).toBe(first.sessionId);
    expect(getStoredSessionConfig(first.sessionId)).toMatchObject({ provider: "codex", model: "gpt-test" });
  });

  test("refuses what cannot be resumed", () => {
    const missing = importExternalSession({ provider: "claude-code", id: "44444444-dddd-4ddd-8ddd-444444444444", roots });
    expect(missing).toMatchObject({ ok: false, status: 404 });

    const gone = join(temp, "deleted-project");
    const GONE = "55555555-eeee-4eee-8eee-555555555555";
    writeClaudeSession(GONE, gone, claudeRecords(gone));
    expect(importExternalSession({ provider: "claude-code", id: GONE, roots })).toMatchObject({ ok: false, status: 409 });

    expect(importExternalSession({ provider: "claude-code", id: "../escape", roots })).toMatchObject({ ok: false, status: 404 });
  });
});
