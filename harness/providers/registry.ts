/**
 * Provider Registry — maps provider names to SessionProvider implementations.
 *
 * Adding a new provider: import it, register it. That's it.
 */

import type { ProviderCapabilities, SessionProvider } from "./types";
import { createClaudeCodeProvider } from "./claude-code";
import { createClaudeCodePtyProvider } from "./claude-code-pty";
import { createCodexProvider } from "./codex";
import { createCursorProvider } from "./cursor";
import { createOpenCodeProvider } from "./opencode";
import { createAntigravityProvider } from "./antigravity";
// Lazy-imported: Gemini CLI core spams "Experiments loaded" on import
import { createPiAgentProvider, type PiProviderName } from "./pi-agent";
import { GEMINI_CAPABILITIES } from "./gemini-cli-capabilities";
import { OPENCODE_CAPABILITIES } from "./opencode-capabilities";
import { ANTIGRAVITY_CAPABILITIES } from "./antigravity-capabilities";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { isSecretSet } from "../secrets";
import { resolveCursorAgentExecutable } from "./cursor-resolve-bin";
import {
  antigravityAuthFromModelsResult,
  resolveAntigravityExecutable,
  runAntigravityCommand,
} from "./antigravity-cli-runtime";

const PI_PROVIDERS: PiProviderName[] = ["litellm", "ollama", "openrouter"];
const STANDALONE_PROVIDERS = ["claude-code", "claude-code-pty", "codex", "cursor", "antigravity", "opencode"] as const;
const HIDDEN_LEGACY_PROVIDERS = ["gemini-cli"] as const;

// Lazy-init cache
const cache = new Map<string, SessionProvider>();

export function getProvider(name: string): SessionProvider {
  const cached = cache.get(name);
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
    // Gemini CLI core must NOT be imported at module load time —
    // it spams "Experiments loaded" + experiment IDs to console on every import.
    // Use a variable path to prevent Bun from statically resolving the import.
    const modPath = [".", "gemini-cli"].join("/");
    const mod = require(modPath);
    provider = mod.createGeminiCliProvider();
  } else if (PI_PROVIDERS.includes(name as PiProviderName)) {
    provider = createPiAgentProvider(name as PiProviderName);
  } else {
    throw new Error(`Unknown provider: "${name}". Available: ${[...STANDALONE_PROVIDERS, ...PI_PROVIDERS].join(", ")}`);
  }

  cache.set(name, provider);
  return provider;
}

export function isKnownProvider(name: string): boolean {
  return STANDALONE_PROVIDERS.includes(name as (typeof STANDALONE_PROVIDERS)[number])
    || HIDDEN_LEGACY_PROVIDERS.includes(name as (typeof HIDDEN_LEGACY_PROVIDERS)[number])
    || PI_PROVIDERS.includes(name as PiProviderName);
}

export function listProviders(): string[] {
  return [...STANDALONE_PROVIDERS, ...PI_PROVIDERS];
}

export function getProviderCapabilities(name: string): ProviderCapabilities {
  // Short-circuit gemini-cli — its provider module imports @google/gemini-cli-core
  // which fires a network call to Google's experiment service on load. Capability
  // listing must NOT pay that cost. Only `getProvider("gemini-cli")` (called when
  // a session actually starts) should trigger the SDK import.
  if (name === "gemini-cli") return GEMINI_CAPABILITIES;
  if (name === "antigravity") return ANTIGRAVITY_CAPABILITIES;
  if (name === "opencode") return OPENCODE_CAPABILITIES;
  return getProvider(name).capabilities;
}

export function listProviderCapabilities(): ProviderCapabilities[] {
  return listProviders().map((name) => getProviderCapabilities(name));
}

// ── Provider Health ──

type ProviderHealthCheck = {
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

/** Per-provider prerequisites: which CLI binary and/or env vars are required. */
const PROVIDER_PREREQS: Record<string, { cli?: string; envAny?: string[] }> = {
  "claude-code": { cli: "claude" },
  "claude-code-pty": { cli: "claude" },
  "codex": { cli: "codex" },
  "cursor": { cli: "cursor-agent" },
  "antigravity": { cli: "agy" },
  "opencode": { cli: "opencode" },
  "openrouter": { envAny: ["OPENROUTER_API_KEY"] },
  // litellm and ollama: local services, checked via ping below
};

async function pingLocal(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/** Check if Codex CLI auth is available (API key in secrets/env OR ~/.codex/auth.json). */
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

/** Check availability of all registered providers. Returns health info per provider. */
export async function checkAllProviderHealth(): Promise<ProviderHealthInfo[]> {
  return Promise.all(listProviders().map(async (name) => {
    const caps = getProviderCapabilities(name);
    const spec = PROVIDER_PREREQS[name];
    const checks: ProviderHealthCheck[] = [];

    // CLI binary check
    if (spec?.cli) {
      const found =
        name === "cursor"
          ? resolveCursorAgentExecutable()
          : name === "antigravity"
            ? resolveAntigravityExecutable()
            : name === "opencode"
              ? Bun.which("opencode") ?? Bun.which("bunx")
              : Bun.which(spec.cli);
      checks.push({
        type: "cli",
        label: spec.cli,
        passed: !!found,
        detail: found ? (name === "opencode" && !Bun.which("opencode") ? `${found} (uses bunx opencode-ai fallback)` : found) : "not in PATH",
      });
    }

    // Environment variable check — uses isSecretSet to cover secrets file + env
    if (spec?.envAny?.length) {
      const found = spec.envAny.find(v => isSecretSet(v));
      checks.push({
        type: "env",
        label: spec.envAny.join(" / "),
        passed: !!found,
        detail: found ? `${found} set` : "not set",
      });
    }

    // Provider-specific auth checks
    if (name === "codex") {
      checks.push(checkCodexAuth());
    }
    if (name === "antigravity") {
      const executable = resolveAntigravityExecutable();
      if (executable) {
        const auth = antigravityAuthFromModelsResult(await runAntigravityCommand(executable, ["models"], { timeoutMs: 15_000 }));
        checks.push({ type: "auth", label: "google sign-in", passed: auth.authenticated, detail: auth.detail });
      }
    }

    // Local service reachability
    if (name === "litellm") {
      const url = process.env.LITELLM_BASE_URL ?? "http://localhost:4000";
      const ok = await pingLocal(`${url.replace(/\/+$/, "")}/health`);
      checks.push({ type: "local", label: "proxy", passed: ok, detail: ok ? url : `${url} unreachable` });
    }
    if (name === "ollama") {
      const url = process.env.OLLAMA_HOST ?? "http://localhost:11434";
      const ok = await pingLocal(url);
      checks.push({ type: "local", label: "server", passed: ok, detail: ok ? url : `${url} unreachable` });
    }

    // Determine overall status
    let status: ProviderHealthInfo["status"];
    if (checks.length === 0) {
      status = "unknown";
    } else if (checks.every(c => c.passed)) {
      status = "ready";
    } else if (checks.some(c => c.passed)) {
      status = "misconfigured";
    } else {
      status = "unavailable";
    }

    return { name, label: caps.label, family: caps.family, status, checks };
  }));
}
