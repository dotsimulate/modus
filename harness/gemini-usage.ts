import {
  antigravityAuthFromModelsResult,
  resolveAntigravityExecutable,
  runAntigravityCommand,
} from "./providers/antigravity-cli-runtime";

/**
 * Backward-compatible response shape for the existing status-bar endpoint.
 * Antigravity currently exposes quota only through its interactive `/usage`
 * panel, so Modus reports auth availability without fabricating quota values.
 */
export type GeminiUsageSnapshot = {
  available: boolean;
  authType: string;
  model: string;
  checkedAt: number;
  quota: {
    remaining?: number;
    limit?: number;
    resetTime?: string;
  };
  tier?: string;
  paidTier?: string;
  error?: string;
};

export async function fetchGeminiUsageSnapshot(opts: {
  cwd?: string;
  model?: string;
} = {}): Promise<GeminiUsageSnapshot> {
  const model = opts.model ?? "Gemini 3.5 Flash";
  const executable = resolveAntigravityExecutable();
  if (!executable) {
    return {
      available: false,
      authType: "antigravity-keyring",
      model,
      checkedAt: Date.now(),
      quota: {},
      error: "Antigravity CLI (`agy`) is not installed.",
    };
  }

  const result = await runAntigravityCommand(executable, ["models"], {
    cwd: opts.cwd,
    timeoutMs: 15_000,
  });
  const auth = antigravityAuthFromModelsResult(result);
  return {
    // Keep false because no numeric quota was returned. The legacy UI only
    // renders this block when real remaining/limit values are available.
    available: false,
    authType: "antigravity-keyring",
    model,
    checkedAt: Date.now(),
    quota: {},
    ...(!auth.authenticated ? { error: auth.detail } : {}),
  };
}
