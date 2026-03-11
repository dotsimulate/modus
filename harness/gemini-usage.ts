import { ApprovalMode, AuthType, Config } from "@google/gemini-cli-core";

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
  const cwd = opts.cwd ?? process.cwd();
  const model = opts.model ?? "auto-gemini-3";

  try {
    const config = new Config({
      sessionId: `gemini-usage-${crypto.randomUUID()}`,
      targetDir: cwd,
      cwd,
      debugMode: false,
      interactive: false,
      noBrowser: true,
      model,
      approvalMode: ApprovalMode.YOLO,
    });

    await config.initialize();
    await config.refreshAuth(AuthType.LOGIN_WITH_GOOGLE);
    await config.refreshUserQuotaIfStale(0);

    const remaining = config.getQuotaRemaining();
    const limit = config.getQuotaLimit();
    const resetTime = config.getQuotaResetTime();

    return {
      available: remaining != null || limit != null || !!resetTime,
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model,
      checkedAt: Date.now(),
      quota: {
        ...(remaining != null ? { remaining } : {}),
        ...(limit != null ? { limit } : {}),
        ...(resetTime ? { resetTime } : {}),
      },
      tier: config.getUserTierName(),
      paidTier: config.getUserPaidTier() ? String(config.getUserPaidTier()) : undefined,
    };
  } catch (error) {
    return {
      available: false,
      authType: AuthType.LOGIN_WITH_GOOGLE,
      model,
      checkedAt: Date.now(),
      quota: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
