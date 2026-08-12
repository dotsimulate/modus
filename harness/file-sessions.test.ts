/**
 * getSessionsForFile — the query behind the code editor's file-history menu.
 *
 * Runs against an isolated MODUS_HOME so it never reads the developer's live
 * harness.db. db.ts opens its database at import time, so the environment has
 * to be set before the dynamic import below.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const ROOT = join(tmpdir(), `modus-file-sessions-${crypto.randomUUID()}`);
mkdirSync(join(ROOT, "data"), { recursive: true });
process.env.MODUS_HOME = ROOT;
process.env.HARNESS_SECRETS_FILE = join(ROOT, "secrets.env");

type Db = typeof import("./db");
let db: Db;

const PROJECT = process.platform === "win32" ? "D:\\work\\proj" : "/work/proj";
const TARGET = join(PROJECT, "src", "Widget.tsx");
const OTHER = join(PROJECT, "src", "Other.tsx");

function session(id: string, opts: Partial<Parameters<Db["upsertSession"]>[0]> = {}) {
  db.upsertSession({
    id,
    preview: `preview ${id}`,
    messageCount: 1,
    costUsd: 0,
    cwd: PROJECT,
    ...opts,
  });
}

function observe(sessionId: string, path: string, operation: "write" | "edit", seq = 1) {
  db.insertFileObservation({
    sessionId,
    seq,
    provider: "claude-code",
    toolName: operation === "write" ? "Write" : "Edit",
    path,
    operation,
  });
}

beforeAll(async () => {
  db = await import("./db");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("getSessionsForFile", () => {
  test("returns only sessions that touched the file, most recent first", async () => {
    session("s-old", { title: "older work" });
    session("s-new", { title: "newer work" });
    session("s-unrelated", { title: "untouched" });

    observe("s-old", TARGET, "edit");
    await Bun.sleep(5);
    observe("s-new", TARGET, "write");
    observe("s-unrelated", OTHER, "edit");

    const found = db.getSessionsForFile(TARGET, 10);
    expect(found.map((f) => f.sessionId)).toEqual(["s-new", "s-old"]);
    expect(found[0]!.title).toBe("newer work");
  });

  test("counts writes and edits separately and keeps the latest touch time", async () => {
    session("s-counts");
    observe("s-counts", TARGET, "edit", 1);
    observe("s-counts", TARGET, "edit", 2);
    await Bun.sleep(5);
    observe("s-counts", TARGET, "write", 3);

    const ref = db.getSessionsForFile(TARGET, 10).find((f) => f.sessionId === "s-counts")!;
    expect(ref.editCount).toBe(2);
    expect(ref.writeCount).toBe(1);
    expect(ref.lastSeq).toBe(3);
  });

  test("resolves relative observation paths against the session cwd", () => {
    // observeDeclaredFileTools stores the provider's raw path, so a provider
    // that emits a relative path must still match the absolute file the UI asks about.
    session("s-relative");
    observe("s-relative", join("src", "Widget.tsx"), "edit");

    const ids = db.getSessionsForFile(TARGET, 10).map((f) => f.sessionId);
    expect(ids).toContain("s-relative");
  });

  test("does not match a same-named file in another directory", () => {
    session("s-samename", { cwd: join(PROJECT, "vendor") });
    observe("s-samename", join(PROJECT, "vendor", "src", "Widget.tsx"), "edit");

    const ids = db.getSessionsForFile(TARGET, 10).map((f) => f.sessionId);
    expect(ids).not.toContain("s-samename");
  });

  test("honors the limit", () => {
    expect(db.getSessionsForFile(TARGET, 1)).toHaveLength(1);
  });

  test("treats LIKE wildcards in a filename as literal characters", () => {
    const odd = join(PROJECT, "src", "100%_report_v_1.md");
    session("s-odd");
    observe("s-odd", odd, "write");

    expect(db.getSessionsForFile(odd, 10).map((f) => f.sessionId)).toEqual(["s-odd"]);
    // The wildcard must not make an unrelated file match the pattern.
    const decoy = join(PROJECT, "src", "1009_report_vX1.md");
    session("s-decoy");
    observe("s-decoy", decoy, "write");
    expect(db.getSessionsForFile(odd, 10).map((f) => f.sessionId)).toEqual(["s-odd"]);
  });

  test("returns nothing for an unknown file or a blank path", () => {
    expect(db.getSessionsForFile(join(PROJECT, "nope.ts"), 5)).toEqual([]);
    expect(db.getSessionsForFile("   ", 5)).toEqual([]);
  });

  test("matches when the query uses forward or mixed separators (FileBrowser UI)", () => {
    // FileBrowser builds child paths as `${dirPath}/${name}`, so on Windows the
    // menu often asks with `D:\proj/src/Widget.tsx` while Claude stores
    // `D:\proj\src\Widget.tsx`. Case-only equality silently empties the menu.
    session("s-sep");
    observe("s-sep", TARGET, "write");

    const forward = TARGET.replace(/\\/g, "/");
    const mixed = process.platform === "win32"
      ? `${PROJECT}/src/Widget.tsx`
      : TARGET;

    expect(db.getSessionsForFile(forward, 10).map((f) => f.sessionId)).toContain("s-sep");
    expect(db.getSessionsForFile(mixed, 10).map((f) => f.sessionId)).toContain("s-sep");
  });

  test("matches when the observation used forward slashes and the query uses native", () => {
    session("s-obs-fwd");
    const stored = TARGET.replace(/\\/g, "/");
    observe("s-obs-fwd", stored, "edit");
    expect(db.getSessionsForFile(TARGET, 10).map((f) => f.sessionId)).toContain("s-obs-fwd");
  });
});
