import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
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

  test("canonicalizes mixed-case slugs and collapses case-insensitive lookup", () => {
    const paths = testPaths();
    expect(registerVault({ slug: "Private", name: "Private", createdAt: 100 }, paths)).toEqual({
      slug: "private",
      name: "Private",
      createdAt: 100,
    });
    expect(getVault("PRIVATE", paths)?.slug).toBe("private");
    expect(ensureVaultRegistered("PrIvAtE", paths, 200)?.createdAt).toBe(100);
    expect(listVaults(paths)).toHaveLength(1);
  });

  test("normalizes legacy mixed-case rows and rejects canonical duplicates as corrupt", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const registryPath = join(paths.modusHome, "vaults.json");
    writeFileSync(registryPath, JSON.stringify({
      vaults: [{ slug: "Private", createdAt: 100 }],
    }), "utf8");
    expect(listVaults(paths)).toEqual([{ slug: "private", createdAt: 100 }]);

    writeFileSync(registryPath, JSON.stringify({
      vaults: [
        { slug: "Private", createdAt: 100 },
        { slug: "private", createdAt: 200 },
      ],
    }), "utf8");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(listVaults(paths)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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

  test("registry mutation does not steal a stale-looking lock from a live process", async () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const lockPath = join(paths.modusHome, "vaults.json.lock");
    writeFileSync(lockPath, `${process.pid}:test-owner\n`, "utf8");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const registryUrl = pathToFileURL(resolve(import.meta.dir, "..", "vault-registry.ts")).href;
    const script = `
      const { registerVault } = await import(${JSON.stringify(registryUrl)});
      registerVault({ slug: "private", createdAt: 100 }, { modusHome: ${JSON.stringify(paths.modusHome)} });
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      env: {
        ...process.env,
        MODUS_HOME: paths.modusHome,
        MODUS_DATA_DIR: join(paths.modusHome, "isolated-data"),
        MODUS_LOGS_DIR: join(paths.modusHome, "isolated-logs"),
        MODUS_RUNTIME_DIR: join(paths.modusHome, "isolated-runtime"),
        MODUS_CACHE_DIR: join(paths.modusHome, "isolated-cache"),
        HARNESS_SECRETS_FILE: join(paths.modusHome, "isolated-secrets.env"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    await Bun.sleep(100);
    const waitedForLock = child.exitCode === null;
    rmSync(lockPath, { force: true });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(waitedForLock).toBe(true);
    expect(exitCode, stderr).toBe(0);
    expect(getVault("private", paths)).not.toBeNull();
  });

  test("recovers a stale registry lock and publishes through an atomic rename", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const lockPath = join(paths.modusHome, "vaults.json.lock");
    writeFileSync(lockPath, "abandoned-owner\n", "utf8");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    registerVault({ slug: "private", createdAt: 100 }, paths);
    expect(getVault("private", paths)).not.toBeNull();
    expect(existsSync(lockPath)).toBe(false);

    const source = readFileSync(resolve(import.meta.dir, "..", "vault-registry.ts"), "utf8");
    expect(source).toContain("renameSync(temporaryPath, path)");
  });
});
