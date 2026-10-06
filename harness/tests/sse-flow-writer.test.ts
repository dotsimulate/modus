import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSseFlowLog, sseTimestamp } from "../sse-flow-log";

describe("SSE diagnostic writer", () => {
  test("keeps locale timestamps including midnight and clock changes", () => {
    for (const iso of ["2026-01-01T00:00:00.123Z", "2026-07-01T13:14:15.678Z", "2025-01-01T00:00:00.001Z"]) {
      const date = new Date(iso);
      expect(sseTimestamp(date)).toBe(date.toLocaleTimeString("en-US", {
        hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
      }));
    }
  });

  test("appends complete UTF-8 lines, rotates its own handle, and reopens after close", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-flow-log-"));
    const file = join(dir, "sse.log");
    const log = createSseFlowLog(file, { maxBytes: 90, checkBytes: 1 });
    try {
      writeFileSync(file, "previous generation".repeat(10));
      log.write("LIVE", "abcdefghijklmnop", "Δ text");
      expect(readFileSync(file + ".1", "utf8")).toContain("previous generation");
      expect(readFileSync(file, "utf8")).toMatch(/\[abcdefghijkl\] LIVE: Δ text\n$/);
      log.close();
      log.write("END", undefined, "done");
      expect(readFileSync(file, "utf8")).toContain("[------------] END: done");
      for (let i = 0; i < 10; i++) log.write("LIVE", "fixture", String(i));
      expect(readFileSync(file + ".1", "utf8")).toContain("LIVE");
      expect(readFileSync(file, "utf8")).toContain("LIVE: 9");
    } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("diagnostic failures do not escape and later writes can recover", () => {
    const dir = mkdtempSync(join(tmpdir(), "modus-flow-error-"));
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "file");
    const log = createSseFlowLog(join(blocker, "sse.log"));
    try {
      expect(() => log.write("LIVE", undefined, "fails")).not.toThrow();
      rmSync(blocker);
      log.write("LIVE", undefined, "recovered");
      expect(readFileSync(join(blocker, "sse.log"), "utf8")).toContain("recovered");
    } finally { log.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
