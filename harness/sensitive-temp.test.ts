import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  createSensitiveTempDirectory,
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
