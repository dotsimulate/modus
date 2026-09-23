import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCursorMcpConfigStore } from "../../providers/cursor-mcp-config";

const CANARY = "Bearer supervisor-canary-do-not-strand";
const INSTALLED = JSON.stringify({ mcpServers: { modus: { url: "http://x", headers: { Authorization: CANARY } } } });

let root: string;
let project: string;
let journalDir: string;
let mcpPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modus-cursor-mcp-test-"));
  project = join(root, "project");
  journalDir = join(root, "runtime", "cursor-mcp");
  mcpPath = join(project, ".cursor", "mcp.json");
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("cursor project MCP config journal", () => {
  test("removes a Modus-created file and leaves no credential behind", () => {
    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);
    expect(readFileSync(mcpPath, "utf-8")).toContain(CANARY);

    expect(store.restore(journalPath)).toBe("removed");
    expect(existsSync(mcpPath)).toBe(false);
    expect(existsSync(journalPath)).toBe(false);
  });

  test("restores a pre-existing user file byte-for-byte", () => {
    const original = '{\n  "mcpServers": {\n    "mine": { "command": "x" }\n  }\n}\n';
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(mcpPath, original, "utf-8");

    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);
    expect(readFileSync(mcpPath, "utf-8")).toContain(CANARY);

    expect(store.restore(journalPath)).toBe("restored");
    expect(readFileSync(mcpPath, "utf-8")).toBe(original);
  });

  test.skipIf(process.platform === "win32")("restricts an existing readable file before installing credentials, then restores its mode", () => {
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(mcpPath, "original", "utf-8");
    chmodSync(mcpPath, 0o644);

    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(mcpPath, "utf-8")).toContain(CANARY);

    expect(store.restore(journalPath)).toBe("restored");
    expect(readFileSync(mcpPath, "utf-8")).toBe("original");
    expect(statSync(mcpPath).mode & 0o777).toBe(0o644);
  });

  test.skipIf(process.platform !== "win32")("restores a pre-existing read-only file after installing and removing the credential", () => {
    mkdirSync(join(project, ".cursor"), { recursive: true });
    writeFileSync(mcpPath, "original", "utf-8");
    chmodSync(mcpPath, 0o444);

    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);
    expect(readFileSync(mcpPath, "utf-8")).toContain(CANARY);
    expect(statSync(mcpPath).mode & 0o200).toBe(0o200);

    expect(store.restore(journalPath)).toBe("restored");
    expect(readFileSync(mcpPath, "utf-8")).toBe("original");
    expect(statSync(mcpPath).mode & 0o200).toBe(0);
  });

  test("a crashed backend's file is recovered by the next start", () => {
    const crashed = createCursorMcpConfigStore(journalDir);
    crashed.install(mcpPath, INSTALLED);
    expect(readFileSync(mcpPath, "utf-8")).toContain(CANARY);

    // No restore call — simulate the process dying mid-turn.
    const restarted = createCursorMcpConfigStore(journalDir);
    expect(restarted.recoverStranded()).toBe(1);
    expect(existsSync(mcpPath)).toBe(false);
    expect(readdirSync(journalDir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  test("does not clobber a file the user edited while the session ran", () => {
    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);

    const userEdit = '{ "mcpServers": { "userAdded": { "command": "y" } } }';
    writeFileSync(mcpPath, userEdit, "utf-8");

    expect(store.restore(journalPath)).toBe("preserved-user-edit");
    expect(readFileSync(mcpPath, "utf-8")).toBe(userEdit);
    // The journal still goes away, so the credential bytes are never re-applied.
    expect(existsSync(journalPath)).toBe(false);
  });

  test("leaves journals owned by a live foreign process alone", () => {
    const store = createCursorMcpConfigStore(journalDir);
    const journalPath = store.install(mcpPath, INSTALLED);

    const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
    journal.ownerPid = process.ppid && process.ppid !== process.pid ? process.ppid : 1;
    writeFileSync(journalPath, JSON.stringify(journal), "utf-8");

    expect(store.recoverStranded()).toBe(0);
    expect(existsSync(mcpPath)).toBe(true);
  });

  test("discards an unreadable journal without touching the project", () => {
    mkdirSync(journalDir, { recursive: true });
    const bogus = join(journalDir, "bogus.json");
    writeFileSync(bogus, "not json", "utf-8");

    const store = createCursorMcpConfigStore(journalDir);
    expect(store.restore(bogus)).toBe("missing");
    expect(existsSync(bogus)).toBe(false);
  });
});
