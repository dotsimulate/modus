import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";
import type { TurnContent } from "../db";
import { classifyEnding, clip, dayRange, finalText, formatLocal, parseDateBound, resolveTimeZone } from "../moves/session-research/turns";

const NY = "America/New_York";

function assistantTurn(text: string, opts: { blocks?: TurnContent["contentBlocks"] } = {}): TurnContent {
  return { role: "assistant", seq: 1, text, contentBlocks: opts.blocks, timestamp: 0 };
}

describe("session research turn text", () => {
  test("final text is the narration after the last tool call", () => {
    const turn = assistantTurn("Looking first.All done.", {
      blocks: [
        { type: "text", textStart: 0, textEnd: 14 },
        { type: "tool_call", toolCall: { name: "Read" } as never },
        { type: "text", text: "All done." },
      ],
    });
    expect(finalText(turn)).toBe("All done.");
  });

  test("a turn that ends on a tool call falls back to its last narration", () => {
    const turn = assistantTurn("Checking.", {
      blocks: [{ type: "text", text: "Checking." }, { type: "tool_call", toolCall: { name: "Grep" } as never }],
    });
    expect(finalText(turn)).toBe("Checking.");
  });

  test("clip keeps the opening and most of the end", () => {
    const text = `start ${"x".repeat(5000)} the conclusion`;
    const clipped = clip(text, 400);
    expect(clipped.length).toBeLessThanOrEqual(400);
    expect(clipped.startsWith("start")).toBe(true);
    expect(clipped.endsWith("the conclusion")).toBe(true);
    expect(clipped).toContain("chars omitted");
    expect(clip("short", 400)).toBe("short");
  });
});

describe("session research local dates", () => {
  test("a calendar date is local midnight, not UTC", () => {
    expect(parseDateBound("2026-10-08", NY)).toBe(Date.parse("2026-10-08T04:00:00Z"));
    expect(parseDateBound("2026-12-08", NY)).toBe(Date.parse("2026-12-08T05:00:00Z"));
    expect(parseDateBound("2026-10-08", "UTC")).toBe(Date.parse("2026-10-08T00:00:00Z"));
    expect(parseDateBound("2026-10-08T12:00:00Z", NY)).toBe(Date.parse("2026-10-08T12:00:00Z"));
    expect(parseDateBound("not a date", NY)).toBeUndefined();
  });

  test("today and yesterday follow the local calendar", () => {
    const evening = Date.parse("2026-10-09T01:15:00Z"); // 21:15 on the 8th in New York
    expect(parseDateBound("today", NY, evening)).toBe(Date.parse("2026-10-08T04:00:00Z"));
    expect(parseDateBound("yesterday", NY, evening)).toBe(Date.parse("2026-10-07T04:00:00Z"));
    expect(parseDateBound("today", "UTC", evening)).toBe(Date.parse("2026-10-09T00:00:00Z"));
  });

  test("a day spanning a DST change is 25 hours", () => {
    const range = dayRange("2026-11-01", NY)!;
    expect(range[1] - range[0]).toBe(25 * 3_600_000);
  });

  test("formats in the requested zone and rejects unknown zones", () => {
    expect(formatLocal(Date.parse("2026-10-09T01:15:00Z"), NY)).toBe("2026-10-08 21:15");
    expect(formatLocal(undefined, NY)).toBe("n/a");
    expect(resolveTimeZone("Not/AZone")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(resolveTimeZone(NY)).toBe(NY);
  });
});

describe("session research ending guess", () => {
  test("classifies how the last turn ends", () => {
    expect(classifyEnding(assistantTurn("Fixed. Want me to commit it"))).toBe("asks_user");
    expect(classifyEnding(assistantTurn("Nothing committed, waiting on your test."))).toBe("asks_user");
    expect(classifyEnding(assistantTurn("Ready. Which option?"))).toBe("asks_user");
    expect(classifyEnding(assistantTurn("I'll go back to watching for the commit."))).toBe("waiting_on_external");
    expect(classifyEnding(assistantTurn("Build started; I'll keep watching it."))).toBe("waiting_on_external");
    expect(classifyEnding(assistantTurn("Waiting for CI to finish."))).toBe("waiting_on_external");
    expect(classifyEnding(assistantTurn("Done, committed."))).toBe("signed_off");
    expect(classifyEnding(assistantTurn("Should I commit?"), "running")).toBe("mid_work");
    expect(classifyEnding(assistantTurn("Done."), "idle")).toBe("signed_off");
    expect(classifyEnding({ role: "user", seq: 1, text: "hello?", timestamp: 0 })).toBe("mid_work");
    expect(classifyEnding(undefined)).toBe("mid_work");
  });
});

test("session research handlers against an isolated database", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-research-"));
  // The driver owns its database in a separate process, independent of other tests' imports.
  try {
    const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "session-research-driver.ts")], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        MODUS_INSTANCE: "default", MODUS_VAULT_ROOT: "",
        MODUS_HOME: join(root, "home"), MODUS_DATA_DIR: join(root, "data"),
        MODUS_CONFIG_DIR: join(root, "config"), MODUS_RUNTIME_DIR: join(root, "runtime"),
        MODUS_LOGS_DIR: join(root, "logs"), MODUS_CACHE_DIR: join(root, "cache"),
        HARNESS_SECRETS_FILE: join(root, "secrets.env"),
        XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"),
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
  } finally {
    const child = relative(tmpdir(), root);
    if (isAbsolute(child) || !child.startsWith("modus-research-") || child.includes("..")) throw new Error("Unexpected research test directory");
    await removeTreeAfterExit(root);
  }
}, 30_000);
