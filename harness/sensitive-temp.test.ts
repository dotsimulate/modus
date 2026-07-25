import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createSensitiveTempDirectory,
  pruneAbandonedSensitiveTempDirectories,
  removeSensitiveTempDirectory,
  writeSensitiveTempFile,
} from "./sensitive-temp";

describe("sensitive temporary files", () => {
  test("creates private material and removes the complete directory", () => {
    const directory = createSensitiveTempDirectory();
    try {
      const path = writeSensitiveTempFile(directory, "credential.json", '{"token":"canary"}');
      expect(existsSync(path)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
    } finally {
      removeSensitiveTempDirectory(directory);
    }
    expect(existsSync(directory)).toBe(false);
  });

  test("prunes a directory abandoned by a dead process", () => {
    const directory = createSensitiveTempDirectory();
    const secret = writeSensitiveTempFile(directory, "mcp-servers.json", '{"token":"canary"}');
    // PID 2^22 is above every platform's pid_max, so it is reliably not running.
    writeFileSync(join(directory, ".modus-owner"), "4194304", "utf-8");

    expect(pruneAbandonedSensitiveTempDirectories()).toBeGreaterThanOrEqual(1);
    expect(existsSync(secret)).toBe(false);
    expect(existsSync(directory)).toBe(false);
  });

  test("never prunes a live process's directory", () => {
    const directory = createSensitiveTempDirectory();
    try {
      expect(readFileSync(join(directory, ".modus-owner"), "utf-8")).toBe(String(process.pid));
      pruneAbandonedSensitiveTempDirectories();
      expect(existsSync(directory)).toBe(true);
    } finally {
      removeSensitiveTempDirectory(directory);
    }
  });

  test("leaves an unmarked directory alone rather than guessing", () => {
    const directory = createSensitiveTempDirectory();
    try {
      rmSync(join(directory, ".modus-owner"), { force: true });
      pruneAbandonedSensitiveTempDirectories();
      expect(existsSync(directory)).toBe(true);
    } finally {
      removeSensitiveTempDirectory(directory);
    }
  });

  test("refuses nested names and unrelated directories", () => {
    const directory = createSensitiveTempDirectory();
    try {
      expect(() => writeSensitiveTempFile(directory, join("nested", "credential.json"), "secret")).toThrow();
      expect(() => removeSensitiveTempDirectory(join(directory, "nested"))).toThrow();
      expect(basename(directory).startsWith("modus-sensitive-")).toBe(true);
    } finally {
      removeSensitiveTempDirectory(directory);
    }
  });
});
