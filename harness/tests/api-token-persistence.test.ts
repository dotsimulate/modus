import { describe, expect, test } from "bun:test";
import { findApiTokenSession, renameSession, saveApiToken, upsertSession } from "../db";

// `api-` tokens are quoted verbatim in a session's prompt (api-access, ui
// moves). They used to live in a process-local Map, so every harness restart
// turned every resumed session's token into "Invalid API token format". The
// registry is now the harness database; these tests pin that contract.

describe("api token persistence", () => {
  test("a saved token resolves to its session and an unknown token resolves to null", () => {
    const token = `api-test${Date.now().toString(36)}`;
    saveApiToken(token, "session-a");
    expect(findApiTokenSession(token)).toBe("session-a");
    expect(findApiTokenSession("api-never-minted")).toBeNull();
  });

  test("a token follows its session through a rekey", () => {
    const oldId = `tmp-${Date.now().toString(36)}`;
    const newId = `real-${Date.now().toString(36)}`;
    upsertSession({
      id: oldId,
      preview: "rekey test",
      profile: "",
      provider: "claude-code",
      status: "starting",
      cwd: process.cwd(),
      messageCount: 0,
      costUsd: 0,
    });
    const token = `api-rekey${Date.now().toString(36)}`;
    saveApiToken(token, oldId);
    renameSession(oldId, newId);
    expect(findApiTokenSession(token)).toBe(newId);
  });
});
