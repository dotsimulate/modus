import { resolveProfilePrompt, type Profile, type ResolvedProfilePrompt } from "../profiles";
import type { ProviderCapabilities } from "./types";

export function requireSupportedProfilePrompt(
  capabilities: ProviderCapabilities,
  profile?: Profile,
): ResolvedProfilePrompt | undefined {
  const prompt = resolveProfilePrompt(profile);
  if (!prompt?.text) return undefined;
  if (capabilities.profilePrompt.supportedModes.includes(prompt.mode)) return prompt;

  const available = capabilities.profilePrompt.supportedModes.length > 0
    ? `Supported modes: ${capabilities.profilePrompt.supportedModes.join(", ")}.`
    : "Profile prompts are unavailable for this provider.";
  throw new Error(`${capabilities.label} cannot deliver a ${prompt.mode} profile prompt through a system-level channel. ${available} ${capabilities.profilePrompt.summary}`);
}
