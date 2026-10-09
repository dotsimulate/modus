export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8[1m]";

export function providerFallbackModel(provider: string): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "claude-code" || provider === "anthropic") return DEFAULT_CLAUDE_MODEL;
  return "";
}
