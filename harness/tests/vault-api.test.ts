import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AppPaths } from "../app-paths";
import {
  createVaultForApi,
  getVaultPolicyForApi,
  listVaultsForApi,
  setVaultPolicyForApi,
  updateVaultForApi,
  type VaultApiPaths,
} from "../vault-api";
import { ALLOW_ALL_POLICY, DENY_ALL_POLICY } from "../vault-policy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testPaths(instance: string | null = null): VaultApiPaths {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-api-"));
  roots.push(root);
  return { modusHome: join(root, "home"), instance } satisfies Pick<AppPaths, "modusHome" | "instance">;
}

describe("Vault API operations", () => {
  test("the HTTP surface delegates every declared route to the tested operations", () => {
    const source = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
    expect(source).toContain('app.get("/api/vaults"');
    expect(source).toContain('app.post("/api/vaults"');
    expect(source).toContain('app.patch("/api/vaults/:slug"');
    expect(source).toContain('app.get("/api/vaults/:slug/policy"');
    expect(source).toContain('app.put("/api/vaults/:slug/policy"');
    for (const operation of [
      "listVaultsForApi",
      "createVaultForApi",
      "updateVaultForApi",
      "getVaultPolicyForApi",
      "setVaultPolicyForApi",
    ]) {
      expect(source).toContain(`${operation}(`);
    }
  });

  test("lists the implicit default beside registered named Vaults", () => {
    const paths = testPaths("private");
    expect(listVaultsForApi(paths)).toEqual({ current: "private", vaults: [{ slug: null }] });
    expect(createVaultForApi({ slug: "private", name: "Private" }, paths, 100).ok).toBe(true);
    expect(listVaultsForApi(paths)).toEqual({
      current: "private",
      vaults: [
        { slug: null },
        { slug: "private", name: "Private", createdAt: 100 },
      ],
    });
  });

  test("validates creation and reports duplicate slugs as conflicts", () => {
    const paths = testPaths();
    expect(createVaultForApi({}, paths)).toEqual({ ok: false, status: 400, error: "slug is required" });
    expect(createVaultForApi({ slug: "../escape" }, paths)).toEqual({
      ok: false,
      status: 400,
      error: 'Invalid or reserved Vault slug "../escape"',
    });
    expect(createVaultForApi({ slug: "private" }, paths, 100).ok).toBe(true);
    expect(createVaultForApi({ slug: "private" }, paths, 200)).toEqual({
      ok: false,
      status: 409,
      error: 'Vault "private" already exists',
    });
  });

  test("canonicalizes slug casing across create, update, and policy routes", () => {
    const paths = testPaths();
    expect(createVaultForApi({ slug: "Private", name: "Private" }, paths, 100)).toEqual({
      ok: true,
      value: { slug: "private", name: "Private", createdAt: 100 },
    });
    expect(updateVaultForApi("PRIVATE", { autostart: true }, paths)).toEqual({
      ok: true,
      value: { slug: "private", name: "Private", createdAt: 100, autostart: true },
    });
    expect(setVaultPolicyForApi("PrIvAtE", ALLOW_ALL_POLICY, paths)).toEqual({
      ok: true,
      value: ALLOW_ALL_POLICY,
    });
    expect(getVaultPolicyForApi("PRIVATE", paths)).toEqual({ ok: true, value: ALLOW_ALL_POLICY });
  });

  test("patches only the mutable registry fields", () => {
    const paths = testPaths();
    createVaultForApi({ slug: "private" }, paths, 100);

    expect(updateVaultForApi("private", { name: "Private", autostart: true }, paths)).toEqual({
      ok: true,
      value: { slug: "private", name: "Private", createdAt: 100, autostart: true },
    });
    expect(updateVaultForApi("private", { autostart: "yes" }, paths)).toEqual({
      ok: false,
      status: 400,
      error: "autostart must be a boolean",
    });
    expect(updateVaultForApi("missing", {}, paths)).toEqual({
      ok: false,
      status: 404,
      error: 'Vault "missing" not found',
    });
  });

  test("reads and strictly writes policy across Vault roots", () => {
    const paths = testPaths();
    createVaultForApi({ slug: "private" }, paths, 100);
    expect(getVaultPolicyForApi("private", paths)).toEqual({ ok: true, value: DENY_ALL_POLICY });

    expect(setVaultPolicyForApi("private", { plugins: { mode: "allow-all" } }, paths)).toEqual({
      ok: false,
      status: 400,
      error: "Invalid Vault policy",
    });
    expect(setVaultPolicyForApi("private", ALLOW_ALL_POLICY, paths)).toEqual({
      ok: true,
      value: ALLOW_ALL_POLICY,
    });
    expect(getVaultPolicyForApi("private", paths)).toEqual({ ok: true, value: ALLOW_ALL_POLICY });
  });

  test("addresses the implicit default as default but rejects unknown named Vaults", () => {
    const paths = testPaths();
    expect(getVaultPolicyForApi("default", paths)).toEqual({ ok: true, value: ALLOW_ALL_POLICY });
    expect(setVaultPolicyForApi("default", DENY_ALL_POLICY, paths)).toEqual({
      ok: true,
      value: DENY_ALL_POLICY,
    });
    expect(getVaultPolicyForApi("missing", paths)).toEqual({
      ok: false,
      status: 404,
      error: 'Vault "missing" not found',
    });
  });
});
