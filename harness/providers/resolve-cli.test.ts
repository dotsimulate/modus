import { describe, expect, test } from "bun:test";
import { posixUserInstallDirs, resolveCliFrom } from "./resolve-cli";
import { join } from "path";

describe("resolveCliFrom", () => {
  test("returns the first directory containing the command", () => {
    const dirs = ["/a/bin", "/b/bin", "/c/bin"];
    const found = resolveCliFrom("claude", dirs, (path) => path === join("/b/bin", "claude"));
    expect(found).toBe(join("/b/bin", "claude"));
  });

  test("returns null when no directory contains the command", () => {
    expect(resolveCliFrom("claude", ["/a/bin", "/b/bin"], () => false)).toBeNull();
  });

  test("returns null for an empty directory list", () => {
    expect(resolveCliFrom("claude", [], () => true)).toBeNull();
  });
});

describe("posixUserInstallDirs", () => {
  test.skipIf(process.platform === "win32")("probes the user-owned prefixes a desktop launch cannot see", () => {
    const dirs = posixUserInstallDirs("/home/example");
    expect(dirs).toContain(join("/home/example", ".local", "bin"));
    expect(dirs).toContain(join("/home/example", ".bun", "bin"));
    expect(dirs).toContain(join("/home/example", ".claude", "local"));
  });

  test.skipIf(process.platform !== "win32")("is empty on Windows, where PATH already works", () => {
    expect(posixUserInstallDirs("C:\\Users\\example")).toEqual([]);
  });
});
