import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { removeTreeAfterExit } from "./fixtures/remove-tree";
import { normalizeSearchLimit, normalizeSearchOffset, parseSessionSearch } from "../session-search";

describe("session search input", () => {
  test("plain words are prefixes and quotes group phrases", () => {
    expect(parseSessionSearch('  Auth\trefactor "access token" ')).toEqual([
      { text: "Auth", fts: '"Auth"*' },
      { text: "refactor", fts: '"refactor"*' },
      { text: "access token", fts: '"access token"' },
    ]);
    expect(parseSessionSearch('"unfinished phrase')).toEqual([{ text: "unfinished phrase", fts: '"unfinished phrase"' }]);
  });
  test("punctuation, duplicates and FTS operators are safe", () => {
    expect(parseSessionSearch('auth AUTH')).toHaveLength(1);
    expect(parseSessionSearch(' \"\" * - : () ')).toEqual([]);
    expect(parseSessionSearch('OR NEAR(test)')).toEqual([
      { text: "OR", fts: '"OR"*' }, { text: "NEAR", fts: '"NEAR"*' }, { text: "test", fts: '"test"*' },
    ]);
    expect(parseSessionSearch('café 日本語')).toHaveLength(2);
  });
  test("bounds query work and pagination", () => {
    expect(() => parseSessionSearch("x".repeat(4097))).toThrow("4096");
    expect(() => parseSessionSearch(Array.from({ length: 33 }, (_, i) => `term${i}`).join(" "))).toThrow("32");
    expect(normalizeSearchLimit(-1)).toBe(1);
    expect(normalizeSearchLimit(1000)).toBe(200);
    expect(normalizeSearchLimit(NaN)).toBe(20);
    expect(normalizeSearchOffset(-1)).toBe(0);
    expect(normalizeSearchOffset(Infinity)).toBe(0);
  });
});

test("SQLite search matches across messages, sorts before paging and keeps scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "modus-search-"));
  // The driver owns its database in a separate process, independent of other tests' imports.
  try {
    const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, "fixtures", "session-search-driver.ts")], {
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
    if (isAbsolute(child) || !child.startsWith("modus-search-") || child.includes("..")) throw new Error("Unexpected search test directory");
    await removeTreeAfterExit(root);
  }
}, 30_000);
