import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createVault,
  ensureVaultRegistered,
  getVault,
  listVaults,
  registerVault,
  removeVault,
  touchVault,
  type VaultRegistryPaths,
} from "../vault-registry";
import { ALLOW_ALL_POLICY, getVaultPolicy, writeVaultPolicy } from "../vault-policy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testPaths(): VaultRegistryPaths {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-registry-"));
  roots.push(root);
  return { modusHome: join(root, "home") };
}

describe("Vault registry", () => {
  test("starts empty and upserts validated entries", () => {
    const paths = testPaths();
    expect(listVaults(paths)).toEqual([]);

    registerVault({ slug: "private", name: "Private", createdAt: 100 }, paths);
    registerVault({ slug: "private", name: "Renamed", createdAt: 100, autostart: true }, paths);

    expect(listVaults(paths)).toEqual([
      { slug: "private", name: "Renamed", createdAt: 100, autostart: true },
    ]);
    expect(getVault("private", paths)).toEqual({
      slug: "private",
      name: "Renamed",
      createdAt: 100,
      autostart: true,
    });
  });

  test("rejects invalid and reserved slugs", () => {
    const paths = testPaths();
    expect(() => registerVault({ slug: "../escape", createdAt: 1 }, paths)).toThrow();
    expect(() => registerVault({ slug: "default", createdAt: 1 }, paths)).toThrow();
    expect(() => registerVault({ slug: "private", createdAt: Number.NaN }, paths)).toThrow();
  });

  test("treats a corrupt registry as empty and logs the file", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const registryPath = join(paths.modusHome, "vaults.json");
    writeFileSync(registryPath, "{not-json", "utf8");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listVaults(paths)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toContain(registryPath);
    } finally {
      warn.mockRestore();
    }
  });

  test("touches an existing row without inventing a Vault", () => {
    const paths = testPaths();
    registerVault({ slug: "private", createdAt: 100 }, paths);
    expect(touchVault("private", 250, paths)?.lastOpenedAt).toBe(250);
    expect(touchVault("missing", 300, paths)).toBeNull();
    expect(listVaults(paths)).toHaveLength(1);
  });

  test("ensures a CLI-started Vault without replacing an existing row", () => {
    const paths = testPaths();
    expect(ensureVaultRegistered("headless", paths, 100)).toEqual({
      slug: "headless",
      createdAt: 100,
      autostart: false,
    });

    registerVault({ slug: "headless", name: "Headless", createdAt: 100, autostart: true }, paths);
    expect(ensureVaultRegistered("headless", paths, 200)).toEqual({
      slug: "headless",
      name: "Headless",
      createdAt: 100,
      autostart: true,
    });
  });

  test("creation registers first and writes an explicit deny-all policy", () => {
    const paths = testPaths();
    const created = createVault("private", "Private", paths, 100);

    expect(created).toEqual({ slug: "private", name: "Private", createdAt: 100 });
    expect(getVault("private", paths)).toEqual(created);
    expect(getVaultPolicy({
      writableRoot: join(paths.modusHome, "private"),
      instance: "private",
    })).toEqual({
      plugins: { mode: "deny", allow: [] },
      projectAutomation: { mode: "deny", allow: [] },
      channels: { mode: "deny", allow: [] },
    });
  });

  test("duplicate creation refuses instead of resetting an existing policy", () => {
    const paths = testPaths();
    createVault("private", undefined, paths, 100);
    const scope = { writableRoot: join(paths.modusHome, "private"), instance: "private" } as const;
    writeVaultPolicy(ALLOW_ALL_POLICY, scope);

    expect(() => createVault("private", "Again", paths, 200)).toThrow("already exists");
    expect(getVaultPolicy(scope)).toEqual(ALLOW_ALL_POLICY);
  });

  test("removal deletes only the registry row, never Vault data", () => {
    const paths = testPaths();
    createVault("private", undefined, paths, 100);
    const sentinel = join(paths.modusHome, "private", "data", "keep.txt");
    mkdirSync(join(paths.modusHome, "private", "data"), { recursive: true });
    writeFileSync(sentinel, "keep", "utf8");

    expect(removeVault("private", paths)).toBe(true);
    expect(removeVault("private", paths)).toBe(false);
    expect(getVault("private", paths)).toBeNull();
    expect(existsSync(sentinel)).toBe(true);
    expect(JSON.parse(readFileSync(join(paths.modusHome, "private", "vault.json"), "utf8"))).toBeDefined();
  });
});
