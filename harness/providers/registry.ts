/**
 * Provider registry â€” maps standalone implementations and declarative PI
 * definitions onto the shared SessionProvider contract.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { isSecretSet } from "../secrets";
import { createAntigravityProvider } from "./antigravity";
import { ANTIGRAVITY_CAPABILITIES } from "./antigravity-capabilities";
import {
  antigravityAuthFromModelsResult,
  resolveAntigravityExecutable,
  runAntigravityCommand,
} from "./antigravity-cli-runtime";
import { createClaudeCodeProvider } from "./claude-code";
import { createClaudeCodePtyProvider } from "./claude-code-pty";
import { createCodexProvider } from "./codex";
import { createCursorProvider } from "./cursor";
import { resolveCursorAgentExecutable } from "./cursor-resolve-bin";
import { GEMINI_CAPABILITIES } from "./gemini-cli-capabilities";
import { createGrokBuildProvider } from "./grok-build";
import { GROK_BUILD_CAPABILITIES } from "./grok-build-capabilities";
import { probeGrokBuildAuth, resolveGrokBuildCommand } from "./grok-build-runtime";
import { createOpenCodeProvider } from "./opencode";
import { OPENCODE_CAPABILITIES } from "./opencode-capabilities";
import { createPiAgentProvider } from "./pi-agent";
import { getProviderDefinition } from "./provider-definitions";
import { resolveProviderAlias } from "./provider-definition";
import {
  isKnownProvider,
  listProviders,
  readsNativeSkills,
  supportsOneShotCompletion,
  supportsSteering,
  supportsSubprocessOneShot,
} from "./provider-names";
import { resolvePiApiKey, resolvePiBaseUrl } from "./pi-model";
import type { ProviderCapabilities, SessionProvider } from "./types";

export { isKnownProvider, listProviders };

/**
 * Provider *instances* are cached for the process lifetime, which is safe
 * because an instance holds no definition content — it closes over the provider
 * name only, resolves the definition per session start, and exposes
 * `capabilities` as a live getter. Definitions themselves are never cached
 * (see `provider-definitions.ts`), so an edited definition takes effect on the
 * next session without a restart or an invalidation hook.
 */
const cache = new Map<string, SessionProvider>();

export function getProvider(name: string): SessionProvider {
  const definition = getProviderDefinition(name);
  // Keep aliases as distinct cached adapters. The capabilities expose the
  // canonical name, but the runtime adapter must retain the requested name so
  // legacy providerDefaults.litellm and PI model identity keep working.
  const cacheKey = name;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let provider: SessionProvider;
  if (name === "claude-code") {
    provider = createClaudeCodeProvider();
  } else if (name === "claude-code-pty") {
    provider = createClaudeCodePtyProvider();
  } else if (name === "codex") {
    provider = createCodexProvider();
  } else if (name === "cursor") {
    provider = createCursorProvider();
  } else if (name === "opencode") {
    provider = createOpenCodeProvider();
  } else if (name === "antigravity") {
    provider = createAntigravityProvider();
  } else if (name === "grok-build") {
    provider = createGrokBuildProvider();
  } else if (name === "gemini-cli") {
    const supportedLegacyAuth = !!process.env.GEMINI_API_KEY
      || (process.env.GOOGLE_GENAI_USE_VERTEXAI === "true" && (
        !!process.env.GOOGLE_API_KEY
        || !!((process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID) && process.env.GOOGLE_CLOUD_LOCATION)
      ))
      || process.env.CLOUD_SHELL === "true"
      || process.env.GEMINI_CLI_USE_COMPUTE_ADC === "true";
    if (!supportedLegacyAuth) {
      throw new Error("The legacy `gemini-cli` provider is hidden and cannot reuse Gemini CLI OAuth. Use `antigravity`, or explicitly configure a paid Gemini API/Vertex AI/ADC deployment.");
    }
    // Gemini CLI core must not load while merely listing capabilities.
    const modPath = [".", "gemini-cli"].join("/");
    const mod = require(modPath);
    provider = mod.createGeminiCliProvider();
  } else if (definition?.kind === "pi") {
    provider = createPiAgentProvider(name);
  } else {
    throw new Error(
      `Unknown provider: "${name}". Available: ${listProviders().join(", ")}. `
      + `Declarative providers load from <MODUS_HOME>/providers and enabled plugins' .modus/providers directories.`,
    );
  }

  cache.set(cacheKey, provider);
  return provider;
}

export function getProviderCapabilities(name: string): ProviderCapabilities {
  const base =
    name === "gemini-cli" ? GEMINI_CAPABILITIES
    : name === "antigravity" ? ANTIGRAVITY_CAPABILITIES
    : name === "grok-build" ? GROK_BUILD_CAPABILITIES
    : name === "opencode" ? OPENCODE_CAPABILITIES
    : getProvider(name).capabilities;
  return {
    ...base,
    readsNativeSkills: readsNativeSkills(name),
    messageDelivery: supportsSteering(name) ? "steer" : "next-turn",
    supportsOneShotCompletion: supportsOneShotCompletion(name),
    supportsSubprocessOneShot: supportsSubprocessOneShot(name),
  };
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return listProviders().map((name) => getProviderCapabilities(name));
}

// â”€â”€ Provider Health â”€â”€

export type ProviderHealthCheck = {
  type: "cli" | "env" | "local" | "auth";
  label: string;
  passed: boolean;
  detail?: string;
};

export type ProviderHealthInfo = {
  name: string;
  label: string;
  family: string;
  status: "ready" | "misconfigured" | "unavailable" | "unknown";
  checks: ProviderHealthCheck[];
};

const PROVIDER_PREREQS: Record<string, { cli?: string; envAny?: string[] }> = {
  "claude-code": { cli: "claude" },
  "claude-code-pty": { cli: "claude" },
  "codex": { cli: "codex" },
  "cursor": { cli: "cursor-agent" },
  "antigravity": { cli: "agy" },
  "grok-build": { cli: "grok" },
  "opencode": { cli: "opencode" },
};

async function pingLocal(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function checkCodexAuth(): ProviderHealthCheck {
  if (isSecretSet("CODEX_API_KEY") || isSecretSet("OPENAI_API_KEY")) {
    return { type: "auth", label: "api key", passed: true, detail: "key set" };
  }
  const authFile = join(homedir(), ".codex", "auth.json");
  if (existsSync(authFile)) {
    return { type: "auth", label: "auth", passed: true, detail: "oauth" };
  }
  return { type: "auth", label: "api key", passed: false, detail: "no key or oauth" };
}

export async function checkProviderHealth(name: string): Promise<ProviderHealthInfo> {
  const caps = getProviderCapabilities(name);
  const spec = PROVIDER_PREREQS[name];
  const definition = getProviderDefinition(name);
  const checks: ProviderHealthCheck[] = [];
  let missingRequiredConfiguration = false;

  if (spec?.cli) {
    const found =
      name === "cursor"
        ? resolveCursorAgentExecutable()
        : name === "antigravity"
          ? resolveAntigravityExecutable()
          : name === "grok-build"
            ? resolveGrokBuildCommand()?.executable
          : name === "opencode"
            ? Bun.which("opencode") ?? Bun.which("bunx")
            : Bun.which(spec.cli);
    checks.push({
      type: "cli",
      label: spec.cli,
      passed: !!found,
      detail: found
        ? (name === "opencode" && !Bun.which("opencode") ? `${found} (uses bunx opencode-ai fallback)` : found)
        : "not in PATH",
    });
  }

  if (spec?.envAny?.length) {
    const found = spec.envAny.find((name) => isSecretSet(name));
    checks.push({
      type: "env",
      label: spec.envAny.join(" / "),
      passed: !!found,
      detail: found ? `${found} set` : "not set",
    });
  }

  if (name === "codex") checks.push(checkCodexAuth());

  if (name === "antigravity") {
    const executable = resolveAntigravityExecutable();
    if (executable) {
      const auth = antigravityAuthFromModelsResult(
        await runAntigravityCommand(executable, ["models"], { timeoutMs: 15_000 }),
      );
      checks.push({
        type: "auth",
        label: "google sign-in",
        passed: auth.authenticated,
        detail: auth.detail,
      });
    }
  }

  if (name === "grok-build") {
    const auth = await probeGrokBuildAuth();
    checks.push({
      type: "auth",
      label: "xAI sign-in",
      passed: auth.authenticated,
      detail: auth.detail,
    });
  }

  if (definition?.kind === "pi") {
    const apiKeySet = definition.apiKeyName ? isSecretSet(definition.apiKeyName) : false;
    // Naming a secret declares it required unless the definition opts out.
    // Endpoints that accept unauthenticated local requests (the built-in
    // OpenAI-compatible and Ollama definitions, a local vLLM, llama.cpp) set
    // `apiKeyRequired: false` so an unset optional key is not an error.
    const apiKeyRequired = !!definition.apiKeyName && (definition.apiKeyRequired ?? true);
    if (definition.apiKeyName && (apiKeySet || apiKeyRequired)) {
      checks.push({
        type: "env",
        label: definition.apiKeyName,
        passed: apiKeySet,
        detail: apiKeySet ? `${definition.apiKeyName} set` : `${definition.apiKeyName} not set`,
      });
      if (apiKeyRequired && !apiKeySet) missingRequiredConfiguration = true;
    }

    if (!missingRequiredConfiguration) {
      const baseUrl = resolvePiBaseUrl(name);
      const healthUrl = definition.health?.url
        ?? `${baseUrl.replace(/\/+$/, "")}/models`;
      const apiKey = resolvePiApiKey(name);
      const headers = {
        ...(definition.headers ?? {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      const ok = await pingLocal(healthUrl, headers);
      checks.push({
        type: "local",
        label: "models endpoint",
        passed: ok,
        detail: ok ? healthUrl : `${healthUrl} unreachable`,
      });
    }
  }

  let status: ProviderHealthInfo["status"];
  if (missingRequiredConfiguration) {
    status = "misconfigured";
  } else if (checks.length === 0) {
    status = "unknown";
  } else if (checks.every((check) => check.passed)) {
    status = "ready";
  } else if (checks.some((check) => check.passed)) {
    status = "misconfigured";
  } else {
    status = "unavailable";
  }

  return { name, label: caps.label, family: caps.family, status, checks };
}

export async function checkAllProviderHealth(): Promise<ProviderHealthInfo[]> {
  return Promise.all(listProviders().map(checkProviderHealth));
}
