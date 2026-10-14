import { randomBytes } from "crypto";
import { resolveSecret } from "../secrets";
import { GrokAcpClient } from "./grok-build-acp";
import { providerChildEnv } from "./child-env";
import { resolveCli } from "./resolve-cli";

export type MuseCommand = { executable: string; prefixArgs: string[] };

export function resolveMuseCodeCommand(): MuseCommand | null {
  const override = process.env.MODUS_MUSE_CLI?.trim();
  if (override) return { executable: override, prefixArgs: [] };
  const executable = resolveCli("muse");
  return executable ? { executable, prefixArgs: [] } : null;
}

/**
 * The CLI's own sign-in is what bills the Muse Code subscription, so it is the
 * default. MODEL_API_KEY is forwarded only when the user stored it in Modus
 * secrets deliberately; Muse then bills that key pay-as-you-go instead.
 */
export function museCodeEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const apiKey = resolveSecret("MODEL_API_KEY");
  return {
    ...providerChildEnv(),
    ...(apiKey ? { MODEL_API_KEY: apiKey } : {}),
    ...extra,
  };
}

/** MSP requires a UUIDv7 `commandId` on every command (its idempotency handle). */
export function museCommandId(now = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const MUSE_INITIALIZE_PARAMS = {
  clientInfo: { name: "modus", title: "Modus", version: "1" },
  capabilities: {
    requestedCapabilities: ["sessionMcp"],
    // Modus has no surface for Muse's structured question dialogs; declining
    // them makes the host withhold `userInput/request` instead of blocking on it.
    userInputDialogs: false,
  },
};

export function createMuseClient(command: MuseCommand, cwd: string, env: NodeJS.ProcessEnv, requestTimeoutMs?: number) {
  return new GrokAcpClient({
    executable: command.executable,
    args: [...command.prefixArgs, "serve"],
    cwd,
    env,
    sensitiveValues: [env.MODEL_API_KEY],
    label: "Muse MSP",
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  });
}

export type MuseModelInfo = {
  id: string;
  owned_by: "meta";
  contextWindow?: number;
  maxOutputTokens?: number;
  contextSource: "api" | "provider-default";
};

/** `model/list` needs no session, so listing never writes a Muse session to disk. */
export async function probeMuseCodeModels(command = resolveMuseCodeCommand()): Promise<MuseModelInfo[]> {
  if (!command) return [];
  const client = createMuseClient(command, process.cwd(), museCodeEnvironment(), 15_000);
  try {
    client.start();
    await client.request("initialize", MUSE_INITIALIZE_PARAMS, 15_000);
    client.notify("initialized", undefined);
    const listed = await client.request("model/list", {}, 15_000);
    const models = Array.isArray(listed?.models) ? listed.models : [];
    return models
      .filter((model: any) => typeof model?.modelId === "string" && model.modelId)
      .map((model: any) => {
        const contextWindow = typeof model.contextLimit === "number" && model.contextLimit > 0 ? model.contextLimit : undefined;
        const maxOutputTokens = typeof model.outputLimit === "number" && model.outputLimit > 0 ? model.outputLimit : undefined;
        return {
          id: model.modelId,
          owned_by: "meta" as const,
          ...(contextWindow ? { contextWindow } : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          contextSource: contextWindow ? "api" as const : "provider-default" as const,
        };
      });
  } finally {
    await client.close();
  }
}
