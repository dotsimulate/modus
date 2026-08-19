import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveAppPaths, type AppPaths } from "../app-paths";
import {
  ALLOW_ALL_POLICY,
  DENY_ALL_POLICY,
  getVaultPolicy,
  isChannelAllowed,
  isPluginAllowed,
  isProjectAutomationAllowed,
  writeVaultPolicy,
} from "../vault-policy";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function testPaths(instance?: string): AppPaths {
  const root = mkdtempSync(join(tmpdir(), "modus-vault-policy-"));
  roots.push(root);
  return resolveAppPaths({
    env: {
      MODUS_HOME: join(root, "home"),
      MODUS_INSTANCE: instance,
      ...(instance ? { MODUS_VAULT_ROOT: join(root, "chosen-vault") } : {}),
    },
    systemTempDir: join(root, "temp"),
  });
}

function writeRawPolicy(paths: AppPaths, value: unknown): void {
  mkdirSync(paths.writableRoot, { recursive: true });
  writeFileSync(join(paths.writableRoot, "vault.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("Vault policy resolution", () => {
  test("a missing policy preserves the default instance and closes a named Vault", () => {
    expect(getVaultPolicy(testPaths())).toEqual(ALLOW_ALL_POLICY);
    expect(getVaultPolicy(testPaths("private"))).toEqual(DENY_ALL_POLICY);
  });

  test("honors explicit rules and normalizes project roots for comparison", () => {
    const paths = testPaths("private");
    writeRawPolicy(paths, {
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "deny", allow: ["C:\\Work\\Project\\"] },
      channels: { mode: "deny", allow: ["private-webhook"] },
    });

    expect(isPluginAllowed("calendar", paths)).toBe(true);
    expect(isPluginAllowed("mail", paths)).toBe(false);
    expect(isProjectAutomationAllowed("c:/work/project", paths)).toBe(true);
    expect(isProjectAutomationAllowed("C:/Work/Other", paths)).toBe(false);
    expect(isChannelAllowed("private-webhook", paths)).toBe(true);
    expect(isChannelAllowed("public-webhook", paths)).toBe(false);
  });

  test("fills missing keys according to the instance default", () => {
    const defaultPaths = testPaths();
    const namedPaths = testPaths("private");
    writeRawPolicy(defaultPaths, { plugins: { mode: "deny", allow: ["calendar"] } });
    writeRawPolicy(namedPaths, { plugins: { mode: "deny", allow: ["calendar"] } });

    expect(getVaultPolicy(defaultPaths)).toEqual({
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "allow-all" },
      channels: { mode: "allow-all" },
    });
    expect(getVaultPolicy(namedPaths)).toEqual({
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "deny", allow: [] },
      channels: { mode: "deny", allow: [] },
    });
  });

  test("ignores unknown keys without widening known rules", () => {
    const paths = testPaths("private");
    writeRawPolicy(paths, {
      plugins: { mode: "deny", allow: ["calendar"], futureOption: true },
      futureBoundary: { mode: "allow-all" },
    });

    expect(getVaultPolicy(paths)).toEqual({
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "deny", allow: [] },
      channels: { mode: "deny", allow: [] },
    });
  });

  test("fails closed for malformed, invalid, or unreadable policy files", () => {
    for (const paths of [testPaths(), testPaths("private")]) {
      mkdirSync(paths.writableRoot, { recursive: true });
      const policyPath = join(paths.writableRoot, "vault.json");
      writeFileSync(policyPath, "{not-json", "utf8");
      expect(getVaultPolicy(paths)).toEqual(DENY_ALL_POLICY);

      writeRawPolicy(paths, { plugins: { mode: "deny", allow: [42] } });
      expect(getVaultPolicy(paths)).toEqual(DENY_ALL_POLICY);

      rmSync(policyPath, { force: true });
      mkdirSync(policyPath);
      expect(getVaultPolicy(paths)).toEqual(DENY_ALL_POLICY);
    }
  });

  test("reads on every call so an authored policy change takes effect immediately", () => {
    const paths = testPaths("private");
    writeRawPolicy(paths, DENY_ALL_POLICY);
    expect(isPluginAllowed("calendar", paths)).toBe(false);
    writeRawPolicy(paths, ALLOW_ALL_POLICY);
    expect(isPluginAllowed("calendar", paths)).toBe(true);
  });

  test("writes a complete policy beneath the writable root", () => {
    const paths = testPaths("private");
    writeVaultPolicy({
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "allow-all" },
      channels: { mode: "deny", allow: [] },
    }, paths);

    expect(JSON.parse(readFileSync(join(paths.writableRoot, "vault.json"), "utf8"))).toEqual({
      plugins: { mode: "deny", allow: ["calendar"] },
      projectAutomation: { mode: "allow-all" },
      channels: { mode: "deny", allow: [] },
    });
  });

  test("refuses to write a partial runtime value", () => {
    const paths = testPaths("private");
    expect(() => writeVaultPolicy({
      plugins: { mode: "allow-all" },
    } as never, paths)).toThrow("Invalid Vault policy");
  });
});
