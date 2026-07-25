import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { changePin, disablePin, loadSecrets, resetPin, resolveSecret } from "./secrets";

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
});
