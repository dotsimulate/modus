export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_GEMINI_MODEL = "auto-gemini-3";
export const DEFAULT_ANTIGRAVITY_MODEL = "Gemini 3.5 Flash";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-8[1m]";

export function providerFallbackModel(provider: string): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "gemini-cli") return DEFAULT_GEMINI_MODEL;
  if (provider === "antigravity") return DEFAULT_ANTIGRAVITY_MODEL;
  if (provider === "claude-code" || provider === "anthropic") return DEFAULT_CLAUDE_MODEL;
  return "";
}
