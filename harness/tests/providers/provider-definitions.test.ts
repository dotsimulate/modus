import { resolve as resolveTestSourceDir } from "node:path";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

async function runInIsolatedHome(root: string, script: string) {
  const definitionsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "provider-definitions.ts")).href;
  const registryUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "registry.ts")).href;
  const piModelUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "pi-model.ts")).href;
  const modelsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "models.ts")).href;
  const namesUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "provider-names.ts")).href;
  const secretsUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "..", "secrets.ts")).href;
  const profileSchemasUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "..", "profile-schemas.ts")).href;
  const piAgentUrl = pathToFileURL(join(resolveTestSourceDir(import.meta.dir, "..", "..", "providers"), "pi-agent.ts")).href;
  const child = Bun.spawn([process.execPath, "-e", `
    const definitions = await import(${JSON.stringify(definitionsUrl)});
    const registry = await import(${JSON.stringify(registryUrl)});
    const piModel = await import(${JSON.stringify(piModelUrl)});
    const models = await import(${JSON.stringify(modelsUrl)});
    const names = await import(${JSON.stringify(namesUrl)});
    const secrets = await import(${JSON.stringify(secretsUrl)});
    const profileSchemas = await import(${JSON.stringify(profileSchemasUrl)});
    const piAgent = await import(${JSON.stringify(piAgentUrl)});
    ${script}
    process.exit(0);
  `], {
    env: {
      ...process.env,
      MODUS_HOME: join(root, "home"),
      HARNESS_SECRETS_FILE: join(root, "config", "secrets.env"),
      MODUS_RESOURCES_DIR: join(root, "resources"),
      MODUS_DATA_DIR: join(root, "data"),
      MODUS_LOGS_DIR: join(root, "logs"),
      MODUS_RUNTIME_DIR: join(root, "runtime"),
      MODUS_CACHE_DIR: join(root, "cache"),
      LITELLM_BASE_URL: "",
      LITELLM_API_KEY: "",
      OLLAMA_BASE_URL: "",
      OLLAMA_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      OPENROUTER_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  const marker = stdout.indexOf("RESULT:");
  expect(marker, stdout + stderr).toBeGreaterThanOrEqual(0);
  return JSON.parse(stdout.slice(marker + "RESULT:".length).split("\n")[0]!);
}

describe("provider definition discovery", () => {
  test("loads user definitions, rejects built-in shadowing, and skips malformed siblings", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-discovery-"));
    const providersDir = join(root, "home", "providers");
    writeJson(join(providersDir, "valid.json"), {
      name: "test-lmstudio",
      label: "Test LM Studio",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    writeJson(join(providersDir, "shadow.json"), {
      name: "ollama",
      label: "Shadowed Ollama",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    mkdirSync(providersDir, { recursive: true });
    writeFileSync(join(providersDir, "malformed.json"), "{ nope");

    try {
      const result = await runInIsolatedHome(root, `
        const warnings = [];
        console.warn = (...parts) => warnings.push(parts.join(" "));
        const all = definitions.listProviderDefinitions();
        console.log("RESULT:" + JSON.stringify({
          names: all.map((definition) => definition.name),
          custom: definitions.getProviderDefinition("test-lmstudio"),
          ollama: definitions.getProviderDefinition("ollama"),
          warnings,
        }));
      `);
      expect(result.names).toContain("test-lmstudio");
      expect(result.custom.label).toBe("Test LM Studio");
      expect(result.ollama.label).toBe("Ollama");
      expect(result.warnings.join("\n")).toContain("cannot be shadowed");
      expect(result.warnings.join("\n")).toContain("malformed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("user definitions win over enabled plugin definitions", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-precedence-"));
    const plugin = join(root, "plugin");
    writeJson(join(root, "home", "providers", "shared.json"), {
      name: "shared-endpoint",
      label: "User endpoint",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7001/v1",
    });
    writeJson(join(plugin, ".modus", "providers", "shared.json"), {
      name: "shared-endpoint",
      label: "Plugin endpoint",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7002/v1",
    });
    writeJson(join(root, "home", "plugins.json"), {
      plugins: [{ id: "provider-plugin", path: plugin, enabled: true }],
    });

    try {
      const result = await runInIsolatedHome(root, `
        console.log("RESULT:" + JSON.stringify(
          definitions.getProviderDefinition("shared-endpoint"),
        ));
      `);
      expect(result.label).toBe("User endpoint");
      expect(result.baseUrl).toBe("http://127.0.0.1:7001/v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("runtime integration", () => {
  test("legacy litellm profiles and base-url secrets resolve through the canonical provider", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-alias-"));
    try {
      const result = await runInIsolatedHome(root, `
        process.env.LITELLM_BASE_URL = "http://127.0.0.1:4555/v1";
        console.log("RESULT:" + JSON.stringify({
          model: piModel.buildPiModel("litellm", "legacy-model"),
          known: names.isKnownProvider("litellm"),
          listed: names.listProviders(),
        }));
      `);
      expect(result.known).toBe(true);
      expect(result.listed).toContain("openai-compat");
      expect(result.listed).not.toContain("litellm");
      expect(result.model.provider).toBe("litellm");
      expect(result.model.baseUrl).toBe("http://127.0.0.1:4555/v1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("inherits PI capabilities and probes the resolved /models endpoint with secret auth", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-health-"));
    writeJson(join(root, "home", "providers", "keyed.json"), {
      name: "keyed-endpoint",
      label: "Keyed endpoint",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7444/v1",
      apiKeyName: "DECLARATIVE_TEST_API_KEY",
    });
    writeJson(join(root, "home", "providers", "missing.json"), {
      name: "missing-key",
      label: "Missing key",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7555/v1",
      apiKeyName: "DECLARATIVE_MISSING_API_KEY",
    });
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "secrets.env"), "DECLARATIVE_TEST_API_KEY=from-secret-file\n");

    try {
      const result = await runInIsolatedHome(root, `
        delete process.env.DECLARATIVE_TEST_API_KEY;
        delete process.env.DECLARATIVE_MISSING_API_KEY;
        secrets.loadSecrets();
        const requests = [];
        globalThis.fetch = async (input, init) => {
          requests.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("Authorization"),
          });
          return Response.json({ data: [{ id: "model" }] });
        };
        const capabilities = registry.getProviderCapabilities("keyed-endpoint");
        const profileValid = profileSchemas.ProfileSchema.safeParse({
          prompt: "test",
          description: "test",
          provider: "keyed-endpoint",
        }).success;
        const listedModels = await models.fetchProviderModels("keyed-endpoint");
        const keyedHealth = await registry.checkProviderHealth("keyed-endpoint");
        const missingHealth = await registry.checkProviderHealth("missing-key");
        console.log("RESULT:" + JSON.stringify({
          capabilities,
          profileValid,
          listedModels,
          keyedHealth,
          missingHealth,
          requests,
        }));
      `);
      expect(result.capabilities.readsNativeSkills).toBe(true);
      expect(result.capabilities.messageDelivery).toBe("steer");
      expect(result.capabilities.supportsOneShotCompletion).toBe(true);
      expect(result.capabilities.label).toBe("Keyed endpoint");
      expect(result.profileValid).toBe(true);
      expect(result.listedModels.map((model: { id: string }) => model.id)).toEqual(["model"]);
      expect(result.keyedHealth.status).toBe("ready");
      expect(result.requests).toEqual([
        {
          url: "http://127.0.0.1:7444/v1/models",
          authorization: "Bearer from-secret-file",
        },
        {
          url: "http://127.0.0.1:7444/v1/models",
          authorization: "Bearer from-secret-file",
        },
      ]);
      expect(result.missingHealth.status).toBe("misconfigured");
      expect(result.missingHealth.checks[0].detail).toContain("not set");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("keeps multiple OpenAI-compatible endpoints distinct across profiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-multiple-"));
    writeJson(join(root, "home", "providers", "endpoint-a.json"), {
      name: "endpoint-a",
      label: "Endpoint A",
      kind: "pi",
      api: "openai-responses",
      baseUrl: "http://127.0.0.1:7661/v1",
      reasoning: true,
      input: ["text"],
      headers: { "X-Test": "a", Authorization: "Custom scheme" },
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      contextWindow: 32768,
      maxOutputTokens: 4096,
      compat: {},
    });
    writeJson(join(root, "home", "providers", "endpoint-b.json"), {
      name: "endpoint-b",
      label: "Endpoint B",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:7662/v1",
    });

    try {
      const result = await runInIsolatedHome(root, `
        const requests = [];
        globalThis.fetch = async (input, init) => {
          const headers = new Headers(init?.headers);
          requests.push({
            url: String(input),
            authorization: headers.get("Authorization"),
            custom: headers.get("X-Test"),
          });
          return Response.json({ data: [{ id: "listed-model" }] });
        };
        const listedModels = await models.fetchProviderModels("endpoint-a");
        console.log("RESULT:" + JSON.stringify({
          built: [
            piModel.buildPiModel("endpoint-a", "model-a"),
            piModel.buildPiModel("endpoint-b", "model-b"),
          ],
          listedModels,
          requests,
        }));
      `);
      expect(result.built.map((model: { provider: string }) => model.provider))
        .toEqual(["endpoint-a", "endpoint-b"]);
      expect(result.built.map((model: { baseUrl: string }) => model.baseUrl))
        .toEqual(["http://127.0.0.1:7661/v1", "http://127.0.0.1:7662/v1"]);
      expect(result.built[0]).toMatchObject({
        api: "openai-responses",
        reasoning: true,
        input: ["text"],
        headers: { "X-Test": "a", Authorization: "Custom scheme" },
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        contextWindow: 32768,
        maxTokens: 4096,
        compat: {},
      });
      expect(result.listedModels.map((model: { id: string }) => model.id))
        .toEqual(["listed-model"]);
      expect(result.requests).toEqual([{
        url: "http://127.0.0.1:7661/v1/models",
        authorization: "Custom scheme",
        custom: "a",
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("definitions are not cached", () => {
  test("a new definition file is visible without any invalidation or restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-live-"));
    try {
      const result = await runInIsolatedHome(root, `
        const { mkdirSync, writeFileSync, rmSync } = await import("fs");
        const { join } = await import("path");
        const dir = join(process.env.MODUS_HOME, "providers");
        mkdirSync(dir, { recursive: true });

        // Force a first read so any cache would already be populated.
        const before = names.listProviders().includes("late-arrival");

        writeFileSync(join(dir, "late.json"), JSON.stringify({
          name: "late-arrival", label: "Arrived Late", kind: "pi",
          api: "openai-completions", baseUrl: "http://127.0.0.1:7799/v1",
        }));
        const afterAdd = names.listProviders().includes("late-arrival");
        const labelAfterAdd = registry.getProviderCapabilities("late-arrival").label;
        const validatesAfterAdd = profileSchemas.ProfileSchema.safeParse({
          prompt: "p", description: "d", provider: "late-arrival",
        }).success;

        // Editing in place must also be picked up — including on the cached
        // provider instance, whose capabilities are a getter.
        registry.getProvider("late-arrival");
        writeFileSync(join(dir, "late.json"), JSON.stringify({
          name: "late-arrival", label: "Renamed Live", kind: "pi",
          api: "openai-completions", baseUrl: "http://127.0.0.1:7800/v1",
        }));
        const labelAfterEdit = registry.getProviderCapabilities("late-arrival").label;
        const baseUrlAfterEdit = piModel.buildPiModel("late-arrival", "m").baseUrl;

        rmSync(join(dir, "late.json"));
        const afterRemove = names.listProviders().includes("late-arrival");

        console.log("RESULT:" + JSON.stringify({
          before, afterAdd, labelAfterAdd, validatesAfterAdd,
          labelAfterEdit, baseUrlAfterEdit, afterRemove,
        }));
      `);
      expect(result.before).toBe(false);
      expect(result.afterAdd).toBe(true);
      expect(result.labelAfterAdd).toBe("Arrived Late");
      expect(result.validatesAfterAdd).toBe(true);
      // Would fail if capabilities were snapshotted at factory construction.
      expect(result.labelAfterEdit).toBe("Renamed Live");
      expect(result.baseUrlAfterEdit).toBe("http://127.0.0.1:7800/v1");
      expect(result.afterRemove).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("apiKeyRequired", () => {
  test("an unset optional key is not misconfigured; an unset required key is", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-optkey-"));
    try {
      const result = await runInIsolatedHome(root, `
        const { mkdirSync, writeFileSync } = await import("fs");
        const { join } = await import("path");
        const dir = join(process.env.MODUS_HOME, "providers");
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "optional.json"), JSON.stringify({
          name: "local-open", kind: "pi", api: "openai-completions",
          baseUrl: "http://127.0.0.1:7801/v1",
          apiKeyName: "LOCAL_OPEN_API_KEY", apiKeyRequired: false,
        }));
        writeFileSync(join(dir, "required.json"), JSON.stringify({
          name: "needs-key", kind: "pi", api: "openai-completions",
          baseUrl: "http://127.0.0.1:7802/v1",
          apiKeyName: "NEEDS_KEY_API_KEY",
        }));
        const optional = await registry.checkProviderHealth("local-open");
        const required = await registry.checkProviderHealth("needs-key");
        console.log("RESULT:" + JSON.stringify({
          optionalStatus: optional.status,
          optionalHasEnvCheck: optional.checks.some((c) => c.type === "env"),
          optionalProbed: optional.checks.some((c) => c.type === "local"),
          requiredStatus: required.status,
          requiredProbed: required.checks.some((c) => c.type === "local"),
        }));
      `);
      // Optional key unset: no env failure, and the endpoint is still probed.
      expect(result.optionalHasEnvCheck).toBe(false);
      expect(result.optionalProbed).toBe(true);
      // Required key unset: misconfigured, and no request is issued.
      expect(result.requiredStatus).toBe("misconfigured");
      expect(result.requiredProbed).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("pricing is definition-driven, not name-driven", () => {
  test("a differently-named definition gets live pricing; one without the block does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "modus-provider-pricing-"));
    writeJson(join(root, "home", "providers", "my-router.json"), {
      name: "my-router",
      label: "My Router",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "https://openrouter.example.test/api/v1",
      pricing: { source: "openrouter" },
    });
    writeJson(join(root, "home", "providers", "plain-gateway.json"), {
      name: "plain-gateway",
      kind: "pi",
      api: "openai-completions",
      baseUrl: "https://plain.example.test/v1",
      cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
    });

    try {
      const result = await runInIsolatedHome(root, `
        const requests = [];
        globalThis.fetch = async (input) => {
          requests.push(String(input));
          return Response.json({ data: [{
            id: "vendor/model-a",
            context_length: 200000,
            pricing: { prompt: "0.000003", completion: "0.000015" },
          }] });
        };
        const priced = await piAgent.fetchDefinitionModelPricing("my-router", "vendor/model-a");
        const unpriced = await piAgent.fetchDefinitionModelPricing("plain-gateway", "anything");
        console.log("RESULT:" + JSON.stringify({ priced, unpriced, requests }));
      `);
      // Real rates, from a provider that is not called "openrouter".
      expect(result.priced).toEqual({
        contextLength: 200000,
        cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
      });
      // No pricing block => null, meaning "use the definition's static cost".
      expect(result.unpriced).toBeNull();
      // Only the declaring provider is fetched, and against its own baseUrl.
      expect(result.requests).toEqual(["https://openrouter.example.test/api/v1/models"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
