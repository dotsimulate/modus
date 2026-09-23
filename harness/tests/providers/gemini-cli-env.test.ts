import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "@google/gemini-cli-core";
import { createTransport } from "@google/gemini-cli-core/dist/src/tools/mcp-client.js";
import { ShellExecutionService } from "@google/gemini-cli-core/dist/src/services/shellExecutionService.js";

const root = mkdtempSync(join(tmpdir(), "modus-gemini-env-"));
const isolated = ["MODUS_HOME", "HARNESS_SECRETS_FILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
const previousRoots = Object.fromEntries(isolated.map((name) => [name, process.env[name]]));
for (const name of isolated) process.env[name] = join(root, name);

const { createGeminiCliProvider } = await import("../../providers/gemini-cli");

const credentials = {
  HARNESS_TOKEN: "supervisor-canary",
  HARNESS_PIN: "harness-pin-canary",
  HARNESS_SECRETS_FILE: join(root, "secrets-canary"),
  HARNESS_TLS_KEY: "tls-key-canary",
  MODUS_PIN: "modus-pin-canary",
  MODUS_TOKEN: "modus-token-canary",
  MODUS_SESSION_MCP_TOKEN: "session-token-canary",
  GEMINI_API_KEY: "gemini-auth-canary",
} as const;

async function withCanaries(
  passthrough: boolean,
  run: () => Promise<void>,
  overrides: Partial<Record<keyof typeof credentials, string>> = {},
  strictGitHubEnvironment = false,
) {
  const names = [...Object.keys(credentials), "MODUS_PROVIDER_ENV_PASSTHROUGH", "GITHUB_SHA", "SURFACE"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, credentials, overrides);
    if (passthrough) process.env.MODUS_PROVIDER_ENV_PASSTHROUGH = "1";
    else delete process.env.MODUS_PROVIDER_ENV_PASSTHROUGH;
    // The pinned SDK enables an additional allowlist when GitHub sets GITHUB_SHA.
    // Select the mode explicitly so these assertions agree on local and CI runners.
    if (strictGitHubEnvironment) process.env.GITHUB_SHA = "synthetic-ci-sha";
    else delete process.env.GITHUB_SHA;
    delete process.env.SURFACE;
    await run();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function captureOptions(explicitPin = "explicit-pin-canary"): Promise<ConstructorParameters<typeof Config>[0]> {
  let captured: ConstructorParameters<typeof Config>[0] | undefined;
  const session = {
    sessionId: "00000000-0000-4000-8000-000000000002",
    cwd: root,
    projectRoot: root,
    abortController: new AbortController(),
    initialContent: "hello",
    pendingDispatch: [],
    status: "starting",
  } as any;
  const ctx = {
    session,
    opts: {
      model: "test-model",
      loadProjectSettings: false,
      mcpServers: {
        inherited: { command: "unused-fake-child", args: [] },
        fixture: {
          command: "unused-fake-child",
          args: [],
          env: { HARNESS_PIN: explicitPin, CUSTOM_CANARY: "explicit-mcp-canary" },
        },
      },
    },
    profile: undefined,
    setProviderSessionId: () => {},
    rekeySession: () => {},
    emitEvent: () => {},
    broadcastEvent: () => {},
    updateSessionDb: () => {},
  } as any;
  const provider = createGeminiCliProvider((options) => {
    captured = options;
    return {
      initialize: async () => { throw new Error("synthetic initialization stop"); },
      dispose: async () => {},
    } as unknown as Config;
  });
  provider.startTurn(ctx);
  await session._providerState.turnCompletion;
  expect(captured).toBeDefined();
  return captured!;
}

async function sdkChildEnvironments(options: ConstructorParameters<typeof Config>[0]) {
  const sanitizationConfig = {
    allowedEnvironmentVariables: options.allowedEnvironmentVariables ?? [],
    blockedEnvironmentVariables: options.blockedEnvironmentVariables ?? [],
    enableEnvironmentVariableRedaction: options.enableEnvironmentVariableRedaction ?? false,
  };
  const cliConfig = {
    isTrustedFolder: () => true,
    sanitizationConfig,
  } as any;
  const transport = await createTransport("fixture", options.mcpServers!.fixture!, false, cliConfig);
  const inheritedTransport = await createTransport("inherited", options.mcpServers!.inherited!, false, cliConfig);
  // createTransport constructs the pinned SDK's real stdio transport but does
  // not start it. Inspect the exact env it would pass to its child.
  const mcpEnv = (transport as any).transport._serverParams.env as Record<string, string>;
  const inheritedMcpEnv = (inheritedTransport as any).transport._serverParams.env as Record<string, string>;
  const shell = await ShellExecutionService.prepareExecution("echo fixture", root, {
    env: options.env,
    sanitizationConfig,
  } as any, false, false);
  try {
    return { mcpEnv, inheritedMcpEnv, shellEnv: shell.env as Record<string, string> };
  } finally {
    shell.cleanup?.();
  }
}

afterAll(() => {
  for (const name of isolated) {
    const prior = previousRoots[name];
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Gemini SDK child environments", () => {
  test("strips inherited Modus credentials from real SDK shell and MCP stdio construction", async () => {
    await withCanaries(false, async () => {
      const options = await captureOptions();
      const { mcpEnv, inheritedMcpEnv, shellEnv } = await sdkChildEnvironments(options);
      for (const name of Object.keys(credentials).filter((name) => name !== "GEMINI_API_KEY")) {
        expect(shellEnv[name]).toBeUndefined();
        expect(inheritedMcpEnv[name]).toBeUndefined();
        if (name !== "HARNESS_PIN") expect(mcpEnv[name]).toBeUndefined();
      }
      expect(shellEnv.GEMINI_API_KEY).toBe(credentials.GEMINI_API_KEY);
      expect(mcpEnv.HARNESS_PIN).toBe("explicit-pin-canary");
      expect(mcpEnv.CUSTOM_CANARY).toBe("explicit-mcp-canary");
    });
  });

  test("explicit passthrough retains inherited Modus credentials and explicit MCP env wins", async () => {
    await withCanaries(true, async () => {
      const options = await captureOptions();
      const { mcpEnv, inheritedMcpEnv, shellEnv } = await sdkChildEnvironments(options);
      for (const [name, value] of Object.entries(credentials)) {
        expect(shellEnv[name]).toBe(value);
        if (name !== "GEMINI_API_KEY") {
          expect(inheritedMcpEnv[name]).toBe(value);
          if (name !== "HARNESS_PIN") expect(mcpEnv[name]).toBe(value);
        }
      }
      expect(mcpEnv.HARNESS_PIN).toBe("explicit-pin-canary");
      expect(mcpEnv.CUSTOM_CANARY).toBe("explicit-mcp-canary");
    });
  });

  for (const passthrough of [false, true]) {
    test(`pinned MCP sanitizer rejects provider-shaped inherited values with passthrough=${passthrough}`, async () => {
      // Built at runtime so no credential-shaped literal enters the source tree.
      const providerShapedCanary = ["gh", "p_", "A".repeat(36)].join("");
      await withCanaries(passthrough, async () => {
        const options = await captureOptions(providerShapedCanary);
        const { mcpEnv, inheritedMcpEnv, shellEnv } = await sdkChildEnvironments(options);
        expect(inheritedMcpEnv.HARNESS_TOKEN).toBeUndefined();
        expect(inheritedMcpEnv.HARNESS_PIN).toBeUndefined();
        expect(inheritedMcpEnv.MODUS_TOKEN).toBe(passthrough ? credentials.MODUS_TOKEN : undefined);
        expect(shellEnv.HARNESS_TOKEN).toBe(passthrough ? providerShapedCanary : undefined);
        expect(shellEnv.HARNESS_PIN).toBe(passthrough ? providerShapedCanary : undefined);
        // Explicit MCP env is merged after the SDK sanitizes inherited values.
        expect(mcpEnv.HARNESS_PIN).toBe(providerShapedCanary);
      }, { HARNESS_TOKEN: providerShapedCanary, HARNESS_PIN: providerShapedCanary });
    });
  }

  test("GitHub runner mode applies the SDK's stricter shell environment filter", async () => {
    await withCanaries(true, async () => {
      const options = await captureOptions();
      const { mcpEnv, inheritedMcpEnv, shellEnv } = await sdkChildEnvironments(options);
      expect(shellEnv.GEMINI_API_KEY).toBeUndefined();
      expect(shellEnv.HARNESS_TOKEN).toBe(credentials.HARNESS_TOKEN);
      expect(shellEnv.MODUS_TOKEN).toBe(credentials.MODUS_TOKEN);
      expect(inheritedMcpEnv.HARNESS_TOKEN).toBe(credentials.HARNESS_TOKEN);
      expect(mcpEnv.HARNESS_PIN).toBe("explicit-pin-canary");
    }, {}, true);
  });
});
