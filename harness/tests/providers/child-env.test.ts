import { describe, expect, test } from "bun:test";
import { PROVIDER_ENV_PASSTHROUGH_VAR, providerChildEnv, strippedProviderEnvNames } from "../../providers/child-env";

const HOST_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/dot",
  LANG: "en_US.UTF-8",
  HTTPS_PROXY: "http://proxy:8080",
  HARNESS_TOKEN: "supervisor-canary",
  HARNESS_PIN: "1234",
  HARNESS_SECRETS_FILE: "/home/dot/.modus/secrets.json",
  HARNESS_TLS_KEY: "/home/dot/.modus/tls.key",
  MODUS_PIN: "1234",
  MODUS_TOKEN: "sdk-canary",
  HARNESS_PORT: "3777",
  ANTHROPIC_API_KEY: "provider-key",
  UNDEFINED_VALUE: undefined,
} satisfies NodeJS.ProcessEnv;

describe("provider child environment policy", () => {
  test("removes every Modus credential from the inherited environment", () => {
    const env = providerChildEnv(HOST_ENV);
    for (const name of ["HARNESS_TOKEN", "HARNESS_PIN", "HARNESS_SECRETS_FILE", "HARNESS_TLS_KEY", "MODUS_PIN", "MODUS_TOKEN"]) {
      expect(env[name]).toBeUndefined();
    }
    expect(Object.values(env)).not.toContain("supervisor-canary");
    expect(Object.values(env)).not.toContain("sdk-canary");
  });

  test("preserves OS, PATH, locale, proxy and provider variables", () => {
    const env = providerChildEnv(HOST_ENV);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dot");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    expect(env.ANTHROPIC_API_KEY).toBe("provider-key");
    expect(env.HARNESS_PORT).toBe("3777");
  });

  test("drops undefined values so the result is a plain string map", () => {
    const env = providerChildEnv(HOST_ENV);
    expect("UNDEFINED_VALUE" in env).toBe(false);
  });

  test("honours the explicit passthrough escape hatch", () => {
    const env = providerChildEnv({ ...HOST_ENV, [PROVIDER_ENV_PASSTHROUGH_VAR]: "1" });
    expect(env.HARNESS_TOKEN).toBe("supervisor-canary");
    expect(strippedProviderEnvNames({ ...HOST_ENV, [PROVIDER_ENV_PASSTHROUGH_VAR]: "1" })).toEqual([]);
  });

  test("does not treat an arbitrary passthrough value as opt-in", () => {
    for (const value of ["0", "false", "no", "", "maybe"]) {
      const env = providerChildEnv({ ...HOST_ENV, [PROVIDER_ENV_PASSTHROUGH_VAR]: value });
      expect(env.HARNESS_TOKEN).toBeUndefined();
    }
  });

  test("does not mutate the source environment", () => {
    const source = { ...HOST_ENV };
    providerChildEnv(source);
    expect(source.HARNESS_TOKEN).toBe("supervisor-canary");
  });
});
