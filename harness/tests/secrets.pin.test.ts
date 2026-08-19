import { resolve as resolveTestSourceDir } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { changePin, disablePin, loadSecrets, resetPin, resolveSecret } from "../secrets";

const directory = mkdtempSync(join(tmpdir(), "modus-pin-secrets-"));
const secretsPath = join(directory, "secrets.env");
const priorSecretsPath = process.env.HARNESS_SECRETS_FILE;
const priorEnvironmentPin = process.env.HARNESS_PIN;

afterAll(() => {
  if (priorSecretsPath === undefined) delete process.env.HARNESS_SECRETS_FILE;
  else process.env.HARNESS_SECRETS_FILE = priorSecretsPath;
  if (priorEnvironmentPin === undefined) delete process.env.HARNESS_PIN;
  else process.env.HARNESS_PIN = priorEnvironmentPin;
  rmSync(directory, { recursive: true, force: true });
});

describe("local PIN recovery storage ownership", () => {
  test("resets and removes only a file-managed PIN", () => {
    process.env.HARNESS_SECRETS_FILE = secretsPath;
    delete process.env.HARNESS_PIN;
    writeFileSync(secretsPath, "HARNESS_PIN=file-pin\n", { mode: 0o600 });
    loadSecrets();

    expect(resetPin("replacement-pin")).toBe(true);
    expect(resolveSecret("HARNESS_PIN")).toBe("replacement-pin");
    expect(disablePin("replacement-pin")).toBe(true);
    expect(resolveSecret("HARNESS_PIN")).toBeUndefined();
  });

  test("does not claim to mutate an environment-managed PIN", () => {
    writeFileSync(secretsPath, "", { mode: 0o600 });
    process.env.HARNESS_PIN = "environment-pin";
    loadSecrets();

    expect(resetPin("replacement-pin")).toBe(false);
    expect(changePin("environment-pin", "replacement-pin")).toBe(false);
    expect(disablePin("environment-pin")).toBe(false);
    expect(resolveSecret("HARNESS_PIN")).toBe("environment-pin");
  });

  test("defaults a named process to its Vault-local secrets file", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-vault-secrets-"));
    const vaultRoot = join(root, "chosen-vault");
    const namedSecrets = join(vaultRoot, "secrets.env");
    mkdirSync(vaultRoot, { recursive: true });
    writeFileSync(namedSecrets, "BOUNDARY_SECRET=named-only\n", { mode: 0o600 });
    const secretsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, ".."), "secrets.ts")).href;
    const env = {
      ...process.env,
      MODUS_HOME: join(root, "main"),
      MODUS_INSTANCE: "private",
      MODUS_VAULT_ROOT: vaultRoot,
      MODUS_DATA_DIR: join(vaultRoot, "data"),
      MODUS_LOGS_DIR: join(vaultRoot, "logs"),
      MODUS_RUNTIME_DIR: join(vaultRoot, "runtime"),
      MODUS_CACHE_DIR: join(vaultRoot, "cache"),
    };
    delete env.HARNESS_SECRETS_FILE;
    delete env.HARNESS_PIN;
    const child = Bun.spawn([process.execPath, "-e", `
      const secrets = await import(${JSON.stringify(secretsUrl)});
      secrets.loadSecrets();
      console.log("RESULT:" + JSON.stringify({
        value: secrets.resolveSecret("BOUNDARY_SECRET"),
        path: secrets.getSecretsInfo().path,
      }));
    `], { env, stdout: "pipe", stderr: "pipe" });
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
      const line = stdout.split(/\r?\n/).find((value) => value.startsWith("RESULT:"));
      expect(line, stdout).toBeDefined();
      expect(JSON.parse(line!.slice("RESULT:".length))).toEqual({
        value: "named-only",
        path: namedSecrets,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
