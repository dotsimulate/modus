/**
 * modus-brain feedback ops — pure-logic tests.
 *
 * runFeedbackList and buildFeedbackEntry are exported pure functions so the
 * paging, filtering, and rejection rules are testable against in-memory
 * entries without touching the real ~/.modus feedback log.
 */

import { describe, expect, test } from "bun:test";
import {
  buildFeedbackEntry,
  corpusBuildStamp,
  formatFeedback,
  runFeedbackList,
  type Feedback,
} from "../moves/modus-brain/context";

function entry(overrides: Partial<Feedback> = {}): Feedback {
  return {
    ts: "2026-07-30T12:00:00.000Z",
    kind: "docs",
    what: "a thing",
    friction: "a rough edge",
    ...overrides,
  };
}

function backlog(n: number): Feedback[] {
  return Array.from({ length: n }, (_, i) =>
    entry({
      ts: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      kind: (["docs", "friction", "missing", "wrong"] as const)[i % 4],
      what: `issue number ${i + 1}`,
      ...(i % 2 === 0 ? { primitive: "move" as const } : {}),
    }));
}

describe("runFeedbackList filters", () => {
  test("an unknown primitive is rejected, not silently unfiltered", () => {
    const result = runFeedbackList(backlog(5), { primitive: "zzz-nonexistent" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown primitive");
    expect(result.error).toContain("client");
  });

  test("an unknown kind is rejected with the valid set", () => {
    const result = runFeedbackList(backlog(5), { kind: "bug" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown kind");
    expect(result.error).toContain("wrong");
  });

  test("an unknown format is rejected", () => {
    const result = runFeedbackList(backlog(5), { format: "csv" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown format");
  });

  test("a valid but empty filter says so", () => {
    const result = runFeedbackList(backlog(4), { primitive: "mission" });
    expect(result.ok).toBe(true);
    expect(result.message).toBe("No feedback filed matching that filter.");
  });

  test("a valid filter narrows and the header reports the filtered count", () => {
    const result = runFeedbackList(backlog(8), { primitive: "move" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("4 entries matching the filter");
  });
});

describe("runFeedbackList overview", () => {
  test("defaults to numbered titles, newest first, with kind and primitive tallies", () => {
    const result = runFeedbackList(backlog(4), {});
    expect(result.ok).toBe(true);
    const lines = result.message!.split("\n");
    expect(lines[0]).toContain("4 entries filed");
    expect(lines[0]).toContain("1 docs");
    expect(lines[1]).toContain("by primitive:");
    expect(lines[1]).toContain("2 move");
    expect(lines[1]).toContain("2 unset");
    // Newest first: entry 4 leads, still numbered by file position.
    const titleLines = lines.filter((l) => /^\d+\. \[/.test(l));
    expect(titleLines).toHaveLength(4);
    expect(titleLines[0]).toStartWith("4. [");
    expect(titleLines[3]).toStartWith("1. [");
    // Titles are one line per entry — friction text stays out of the overview.
    expect(result.message).not.toContain("friction:");
  });

  test("offset and limit page through newest-first", () => {
    const result = runFeedbackList(backlog(20), { limit: 3, offset: 2 });
    const titleLines = result.message!.split("\n").filter((l) => /^\d+\. \[/.test(l));
    expect(titleLines.map((l) => Number.parseInt(l, 10))).toEqual([18, 17, 16]);
    expect(result.message).toContain("offset 2");
  });

  test("full format caps at 8 by default and renders complete entries", () => {
    const result = runFeedbackList(backlog(20), { format: "full" });
    const headers = result.message!.split("\n").filter((l) => l.startsWith("#"));
    expect(headers).toHaveLength(8);
    expect(result.message).toContain("friction:");
  });
});

describe("runFeedbackList entry selector", () => {
  test("returns the single numbered entry in full", () => {
    const entries = backlog(10);
    entries[6] = entry({ what: "the seventh", cwd: "D:\\some\\project", build: "0.1.0" });
    const result = runFeedbackList(entries, { entry: 7 });
    expect(result.ok).toBe(true);
    expect(result.message).toStartWith("#7 ");
    expect(result.message).toContain("the seventh");
    expect(result.message).toContain("from: D:\\some\\project");
    expect(result.message).toContain("(build 0.1.0)");
  });

  test("rejects an out-of-range entry number", () => {
    const result = runFeedbackList(backlog(3), { entry: 99 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("1 to 3");
  });
});

describe("buildFeedbackEntry", () => {
  const opts = { cwd: "D:\\proj", docExists: () => true };

  test("rejects an unknown primitive instead of silently dropping it", () => {
    const result = buildFeedbackEntry(
      { kind: "docs", what: "w", friction: "f", primitive: "widget" },
      opts,
    );
    expect("error" in result && result.error).toContain("unknown primitive");
  });

  test("accepts the client primitive and stamps cwd and build", () => {
    const result = buildFeedbackEntry(
      { kind: "wrong", what: "w", friction: "f", primitive: "client" },
      opts,
    );
    if ("error" in result) throw new Error(result.error);
    expect(result.entry.primitive).toBe("client");
    expect(result.entry.cwd).toBe("D:\\proj");
    expect(result.entry.build).toBe(corpusBuildStamp());
  });

  test("rejects a doc id the registry does not know", () => {
    const result = buildFeedbackEntry(
      { kind: "docs", what: "w", friction: "f", doc: "no-such-doc" },
      { docExists: () => false },
    );
    expect("error" in result && result.error).toContain("unknown doc id");
  });

  test("still requires kind, what, and friction", () => {
    expect("error" in buildFeedbackEntry({ what: "w", friction: "f" }, opts)).toBe(true);
    expect("error" in buildFeedbackEntry({ kind: "docs", friction: "f" }, opts)).toBe(true);
    expect("error" in buildFeedbackEntry({ kind: "docs", what: "w" }, opts)).toBe(true);
  });
});

describe("formatFeedback provenance", () => {
  test("renders the origin project when present", () => {
    const text = formatFeedback(entry({ cwd: "D:\\other\\project" }), 3);
    expect(text).toContain("#3 [docs]");
    expect(text).toContain("from: D:\\other\\project");
  });
});
