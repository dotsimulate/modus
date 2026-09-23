import { resolveSecret } from "../secrets";
import { GrokAcpClient } from "./grok-build-acp";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

export type GrokCommand = { executable: string; prefixArgs: string[] };

export function resolveGrokBuildCommand(): GrokCommand | null {
  const override = process.env.MODUS_GROK_CLI?.trim();
  if (override) return { executable: override, prefixArgs: [] };
  const executable = resolveCli("grok");
  return executable ? { executable, prefixArgs: [] } : null;
}

export function grokBuildEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const apiKey = resolveSecret("XAI_API_KEY");
  return {
    ...providerChildEnv(),
    ...(apiKey ? { XAI_API_KEY: apiKey } : {}),
    ...extra,
  };
}

export function selectGrokBuildAuthMethod(
  initialized: any,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const methods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
  const ids = methods.map((method: any) => String(method?.id ?? method?.methodId ?? method));
  const preferred = env.XAI_API_KEY && ids.includes("xai.api_key")
    ? "xai.api_key"
    : ids.includes("cached_token")
      ? "cached_token"
      : initialized?._meta?.defaultAuthMethodId;
  return preferred && ids.includes(preferred) ? preferred : undefined;
}

export type GrokModelInfo = { id: string; owned_by: "xai"; contextSource: "provider-default" };

const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  clientInfo: { name: "Modus", version: "1" },
  _meta: { clientIdentifier: "modus" },
};

export async function probeGrokBuildModels(command = resolveGrokBuildCommand()): Promise<GrokModelInfo[]> {
  if (!command) return [];
  const env = grokBuildEnvironment();
  const client = new GrokAcpClient({
    executable: command.executable,
    args: [...command.prefixArgs, "--no-auto-update", "agent", "stdio"],
    cwd: process.cwd(),
    env,
    sensitiveValues: [env.XAI_API_KEY],
    requestTimeoutMs: 15_000,
  });
  try {
    client.start();
    const initialized = await client.request("initialize", INITIALIZE_PARAMS, 15_000);
    const state = initialized?._meta?.modelState ?? initialized?.modelState;
    const available = state?.availableModels ?? state?.available_models ?? [];
    if (!Array.isArray(available)) return [];
    return available
      .map((model: any) => model?.modelId ?? model?.model_id ?? model?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      .map((id) => ({ id, owned_by: "xai" as const, contextSource: "provider-default" as const }));
  } finally {
    await client.close();
  }
}

export async function probeGrokBuildAuth(command = resolveGrokBuildCommand()): Promise<{ authenticated: boolean; detail: string }> {
  if (!command) return { authenticated: false, detail: "grok not in PATH" };
  const env = grokBuildEnvironment();
  const client = new GrokAcpClient({
    executable: command.executable,
    args: [...command.prefixArgs, "--no-auto-update", "agent", "stdio"],
    cwd: process.cwd(),
    env,
    sensitiveValues: [env.XAI_API_KEY],
    requestTimeoutMs: 15_000,
  });
  try {
    client.start();
    const initialized = await client.request("initialize", INITIALIZE_PARAMS, 15_000);
    const methods = Array.isArray(initialized?.authMethods) ? initialized.authMethods : [];
    if (!methods.length) return { authenticated: true, detail: "authentication not required" };
    const methodId = selectGrokBuildAuthMethod(initialized, env);
    if (!methodId) {
      return { authenticated: false, detail: "run grok login or set XAI_API_KEY" };
    }
    await client.request("authenticate", { methodId, _meta: { headless: true } }, 15_000);
    return { authenticated: true, detail: env.XAI_API_KEY && methodId === "xai.api_key" ? "XAI_API_KEY" : "cached Grok login" };
  } catch (error) {
    return { authenticated: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close();
  }
}
