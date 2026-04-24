export const DEFAULT_CODEX_MODEL = "gpt-5.4";
export const DEFAULT_GEMINI_MODEL = "auto-gemini-3";
export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-6";

export function providerFallbackModel(provider: string): string {
  if (provider === "codex") return DEFAULT_CODEX_MODEL;
  if (provider === "gemini-cli") return DEFAULT_GEMINI_MODEL;
  if (provider === "claude-code" || provider === "anthropic") return DEFAULT_CLAUDE_MODEL;
  return "";
}
