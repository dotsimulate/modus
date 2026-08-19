import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AppPaths } from "../app-paths";
import {
  createVaultForApi,
  getVaultPolicyForApi,
  listVaultsForApi,
  repairVaultForApi,
  setVaultPolicyForApi,
  updateVaultForApi,
  type VaultApiPaths,
} from "../vault-api";
import { canonicalVaultRoot } from "../vault-registry";
import { ALLOW_ALL_POLICY, DENY_ALL_POLICY } from "../vault-policy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testPaths(instance: string | null = null): VaultApiPaths {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-api-"));
  roots.push(root);
  return { modusHome: join(root, instance ? "named" : "main"), instance } satisfies Pick<AppPaths, "modusHome" | "instance">;
}

function vaultRoot(paths: VaultApiPaths, slug = "private"): string {
  return join(dirname(paths.modusHome), "vault-folders", slug);
}

function createInput(paths: VaultApiPaths, slug = "private", name?: string) {
  const root = vaultRoot(paths, slug);
  mkdirSync(root, { recursive: true });
  return { slug, root, mode: "initialize", ...(name ? { name } : {}) };
}

describe("Vault API operations", () => {
  test("the HTTP surface delegates every declared Main route to tested operations", () => {
    const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(source).toContain('app.get("/api/vaults"');
    expect(source).toContain('app.post("/api/vaults"');
    expect(source).toContain('app.patch("/api/vaults/:slug"');
    expect(source).toContain('app.post("/api/vaults/:slug/repair"');
    expect(source).toContain('app.get("/api/vaults/:slug/policy"');
    expect(source).toContain('app.put("/api/vaults/:slug/policy"');
    for (const operation of [
      "listVaultsForApi",
      "createVaultForApi",
      "updateVaultForApi",
      "repairVaultForApi",
      "getVaultPolicyForApi",
      "setVaultPolicyForApi",
    ]) {
      expect(source).toContain(`${operation}(`);
    }
  });

  test("lists Main beside registered folder-rooted Vaults", () => {
    const paths = testPaths();
    expect(listVaultsForApi(paths)).toEqual({
      current: null,
      vaults: [{ slug: null, name: "Main", root: paths.modusHome }],
    });
    expect(createVaultForApi(createInput(paths, "private", "Private"), paths, 100).ok).toBe(true);
    expect(listVaultsForApi(paths)).toEqual({
      current: null,
      vaults: [
        { slug: null, name: "Main", root: paths.modusHome },
        {
          slug: "private",
          name: "Private",
          root: canonicalVaultRoot(vaultRoot(paths)),
          createdAt: 100,
          autostart: false,
        },
      ],
    });
  });

  test("validates folder creation and reports conflicts", () => {
    const paths = testPaths();
    expect(createVaultForApi({}, paths)).toEqual({ ok: false, status: 400, error: "slug is required" });
    expect(createVaultForApi({ slug: "private" }, paths)).toEqual({ ok: false, status: 400, error: "root is required" });
    expect(createVaultForApi({ slug: "private", root: vaultRoot(paths), mode: "other" }, paths)).toEqual({
      ok: false,
      status: 400,
      error: "mode must be initialize or register",
    });
    expect(createVaultForApi(createInput(paths), paths, 100).ok).toBe(true);
    expect(createVaultForApi({
      slug: "private",
      root: vaultRoot(paths, "different"),
      mode: "initialize",
    }, paths, 200)).toEqual({
      ok: false,
      status: 409,
      error: 'Vault "private" already exists',
    });
  });

  test("repairs a legacy row with an explicit folder", () => {
    const paths = testPaths();
    mkdirSync(paths.modusHome, { recursive: true });
    writeFileSync(join(paths.modusHome, "vaults.json"), JSON.stringify({
      vaults: [{ slug: "private", name: "Private", createdAt: 100, autostart: true }],
    }), "utf8");
    const root = vaultRoot(paths);
    mkdirSync(root, { recursive: true });
    expect(repairVaultForApi("private", { root, mode: "initialize" }, paths, 200)).toEqual({
      ok: true,
      value: {
        slug: "private",
        name: "Private",
        root: canonicalVaultRoot(root),
        createdAt: 100,
        autostart: false,
      },
    });
  });

  test("canonicalizes slug casing across create, update, and policy routes", () => {
    const paths = testPaths();
    expect(createVaultForApi(createInput(paths, "Private", "Private"), paths, 100).ok).toBe(true);
    expect(updateVaultForApi("PRIVATE", { autostart: true }, paths).ok).toBe(true);
    expect(setVaultPolicyForApi("PrIvAtE", ALLOW_ALL_POLICY, paths)).toEqual({
      ok: true,
      value: ALLOW_ALL_POLICY,
    });
    expect(getVaultPolicyForApi("PRIVATE", paths)).toEqual({ ok: true, value: ALLOW_ALL_POLICY });
  });

  test("patches only mutable metadata", () => {
    const paths = testPaths();
    createVaultForApi(createInput(paths), paths, 100);
    const updated = updateVaultForApi("private", { name: "Private", autostart: true }, paths);
    expect(updated.ok && updated.value.name).toBe("Private");
    expect(updated.ok && updated.value.autostart).toBe(true);
    expect(updateVaultForApi("private", { autostart: "yes" }, paths)).toEqual({
      ok: false,
      status: 400,
      error: "autostart must be a boolean",
    });
  });

  test("reads and strictly writes policy at the registered root", () => {
    const paths = testPaths();
    createVaultForApi(createInput(paths), paths, 100);
    expect(getVaultPolicyForApi("private", paths)).toEqual({ ok: true, value: DENY_ALL_POLICY });
    expect(setVaultPolicyForApi("private", { plugins: { mode: "allow-all" } }, paths)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid Vault policy",
    });
    expect(setVaultPolicyForApi("private", ALLOW_ALL_POLICY, paths)).toEqual({ ok: true, value: ALLOW_ALL_POLICY });
  });

  test("named backends cannot read or mutate the Main registry control plane", () => {
    const paths = testPaths("private");
    expect(listVaultsForApi(paths)).toEqual({ current: "private", vaults: [] });
    expect(createVaultForApi({ slug: "sibling", root: vaultRoot(paths), mode: "initialize" }, paths)).toEqual({
      ok: false,
      status: 403,
      error: "Vault registry control is available only from Main",
    });
    expect(updateVaultForApi("sibling", {}, paths).status).toBe(403);
    expect(getVaultPolicyForApi("default", paths).status).toBe(403);
    expect(setVaultPolicyForApi("default", DENY_ALL_POLICY, paths).status).toBe(403);
  });
});
