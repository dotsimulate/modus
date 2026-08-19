import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import {
  canonicalVaultRoot,
  createVault,
  getVault,
  listVaults,
  registerVault,
  removeVault,
  repairVaultRegistration,
  requireRegisteredVault,
  touchVault,
  updateVault,
  VAULT_MANIFEST_FILENAME,
  type VaultRegistryPaths,
} from "../vault-registry";
import { ALLOW_ALL_POLICY, DENY_ALL_POLICY, getVaultPolicy, writeVaultPolicy } from "../vault-policy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testPaths(): VaultRegistryPaths {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-registry-"));
  roots.push(root);
  return { modusHome: join(root, "main") };
}

function externalRoot(paths: VaultRegistryPaths, name: string): string {
  return join(dirname(paths.modusHome), "vault-folders", name);
}

function initialize(
  paths: VaultRegistryPaths,
  slug = "private",
  now = 100,
  name?: string,
) {
  const root = externalRoot(paths, slug);
  mkdirSync(root, { recursive: true });
  return createVault({ slug, root, name, mode: "initialize" }, paths, now);
}

describe("Vault registry", () => {
  test("starts empty and upserts canonical rooted entries", () => {
    const paths = testPaths();
    const root = externalRoot(paths, "private");
    expect(listVaults(paths)).toEqual([]);

    registerVault({ slug: "private", root, name: "Private", createdAt: 100 }, paths);
    registerVault({ slug: "private", root, name: "Renamed", createdAt: 100, autostart: true }, paths);

    expect(listVaults(paths)).toEqual([
      { slug: "private", root: canonicalVaultRoot(root), name: "Renamed", createdAt: 100, autostart: true },
    ]);
    expect(getVault("PRIVATE", paths)?.slug).toBe("private");
  });

  test("keeps slug-only rows visible but disables them pending repair", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    writeFileSync(join(paths.modusHome, "vaults.json"), JSON.stringify({
      vaults: [{ slug: "Private", name: "Old", createdAt: 100, autostart: true }],
    }), "utf8");

    expect(listVaults(paths)).toEqual([{
      slug: "private",
      name: "Old",
      createdAt: 100,
      requiresRepair: true,
      autostart: false,
    }]);
    expect(() => requireRegisteredVault("private", paths)).toThrow("choose a folder");
    expect(() => updateVault("private", { autostart: true }, paths)).toThrow("repaired");
  });

  test("repairs a legacy row into a chosen outside-Main folder without touching legacy data", () => {
    const paths = testPaths();
    const legacySentinel = join(paths.modusHome, "private", "data", "keep.txt");
    mkdirSync(dirname(legacySentinel), { recursive: true });
    writeFileSync(legacySentinel, "keep", "utf8");
    writeFileSync(join(paths.modusHome, "vaults.json"), JSON.stringify({
      vaults: [{ slug: "private", name: "Old", createdAt: 100, autostart: true }],
    }), "utf8");
    const chosen = externalRoot(paths, "repaired-private");
    mkdirSync(chosen, { recursive: true });

    expect(repairVaultRegistration({
      slug: "private",
      root: chosen,
      mode: "initialize",
    }, paths, 200)).toEqual({
      slug: "private",
      name: "Old",
      root: canonicalVaultRoot(chosen),
      createdAt: 100,
      autostart: false,
    });
    expect(requireRegisteredVault("private", paths).root).toBe(canonicalVaultRoot(chosen));
    expect(readFileSync(legacySentinel, "utf8")).toBe("keep");
  });

  test("treats corrupt rows, canonical slug duplicates, and duplicate roots as corrupt", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const registryPath = join(paths.modusHome, "vaults.json");
    const outside = externalRoot(paths, "same");
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const vaults of [
        [{ slug: "private", root: "relative/path", createdAt: 100 }],
        [{ slug: "Private", root: outside, createdAt: 100 }, { slug: "private", root: externalRoot(paths, "other"), createdAt: 200 }],
        [{ slug: "one", root: outside, createdAt: 100 }, { slug: "two", root: outside, createdAt: 200 }],
        [{ slug: "inside", root: join(paths.modusHome, "inside"), createdAt: 100 }],
      ]) {
        writeFileSync(registryPath, JSON.stringify({ vaults }), "utf8");
        expect(listVaults(paths)).toEqual([]);
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("rejects invalid slugs, inside-Main roots, and one folder registered twice", () => {
    const paths = testPaths();
    const outside = externalRoot(paths, "shared");
    expect(() => registerVault({ slug: "../escape", root: outside, createdAt: 1 }, paths)).toThrow();
    expect(() => registerVault({ slug: "default", root: outside, createdAt: 1 }, paths)).toThrow();
    expect(() => registerVault({ slug: "private", root: join(paths.modusHome, "private"), createdAt: 1 }, paths))
      .toThrow("outside Main");
    registerVault({ slug: "one", root: outside, createdAt: 1 }, paths);
    expect(() => registerVault({ slug: "two", root: outside, createdAt: 2 }, paths))
      .toThrow("already registered");
  });

  test("initializes only an empty folder with a versioned marker and deny-all policy", () => {
    const paths = testPaths();
    const created = initialize(paths, "private", 100, "Private");
    expect(created).toEqual({
      slug: "private",
      name: "Private",
      root: canonicalVaultRoot(externalRoot(paths, "private")),
      createdAt: 100,
      autostart: false,
    });
    expect(JSON.parse(readFileSync(join(created.root!, VAULT_MANIFEST_FILENAME), "utf8"))).toEqual({
      version: 1,
      slug: "private",
      createdAt: 100,
    });
    expect(getVaultPolicy({ writableRoot: created.root!, instance: "private" })).toEqual(DENY_ALL_POLICY);
  });

  test("registers an existing marked Vault without overwriting its contents", () => {
    const paths = testPaths();
    const original = initialize(paths, "portable", 100, "Portable");
    writeFileSync(join(original.root!, "keep.txt"), "keep", "utf8");
    expect(removeVault("portable", paths)).toBe(true);

    const registered = createVault({
      slug: "portable",
      root: original.root!,
      name: "Reattached",
      mode: "register",
    }, paths, 200);
    expect(registered.createdAt).toBe(100);
    expect(registered.name).toBe("Reattached");
    expect(readFileSync(join(original.root!, "keep.txt"), "utf8")).toBe("keep");
  });

  test("refuses a non-empty unmarked folder and a manifest for another slug", () => {
    const paths = testPaths();
    const unrelated = externalRoot(paths, "unrelated");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "notes.txt"), "not a Vault", "utf8");
    expect(() => createVault({ slug: "private", root: unrelated, mode: "initialize" }, paths, 100))
      .toThrow("empty folder");
    expect(() => createVault({ slug: "private", root: unrelated, mode: "register" }, paths, 100))
      .toThrow("not a marked Vault");

    const portable = initialize(paths, "portable", 100);
    removeVault("portable", paths);
    expect(() => createVault({ slug: "other", root: portable.root!, mode: "register" }, paths, 200))
      .toThrow('belongs to "portable"');
  });

  test("duplicate creation refuses instead of resetting an existing policy", () => {
    const paths = testPaths();
    const created = initialize(paths);
    const scope = { writableRoot: created.root!, instance: "private" } as const;
    writeVaultPolicy(ALLOW_ALL_POLICY, scope);

    expect(() => createVault({
      slug: "private",
      root: externalRoot(paths, "different"),
      name: "Again",
      mode: "initialize",
    }, paths, 200)).toThrow("already exists");
    expect(getVaultPolicy(scope)).toEqual(ALLOW_ALL_POLICY);
  });

  test("touches rows and unregisters without deleting the folder", () => {
    const paths = testPaths();
    const created = initialize(paths);
    const sentinel = join(created.root!, "data", "keep.txt");
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, "keep", "utf8");
    expect(touchVault("private", 250, paths)?.lastOpenedAt).toBe(250);
    expect(touchVault("missing", 300, paths)).toBeNull();
    expect(removeVault("private", paths)).toBe(true);
    expect(existsSync(sentinel)).toBe(true);
  });

  test("registry mutation does not steal a stale-looking lock from a live process", async () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    const lockPath = join(paths.modusHome, "vaults.json.lock");
    writeFileSync(lockPath, `${process.pid}:test-owner\n`, "utf8");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);
    const registryUrl = pathToFileURL(resolve(import.meta.dir, "..", "vault-registry.ts")).href;
    const rooted = externalRoot(paths, "private");
    const script = `
      const { registerVault } = await import(${JSON.stringify(registryUrl)});
      registerVault({ slug: "private", root: ${JSON.stringify(rooted)}, createdAt: 100 }, { modusHome: ${JSON.stringify(paths.modusHome)} });
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

    registerVault({ slug: "private", root: externalRoot(paths, "private"), createdAt: 100 }, paths);
    expect(getVault("private", paths)).not.toBeNull();
    expect(existsSync(lockPath)).toBe(false);

    const source = readFileSync(resolve(import.meta.dir, "..", "vault-registry.ts"), "utf8");
    expect(source).toContain("renameSync(temporaryPath, path)");
  });
});
