import { describe, expect, test } from "bun:test";
import { KNOWN_PI_APIS, ProviderDefinitionSchema } from "../../providers/provider-definition";
import { fetchProviderModels } from "../../providers/models";
import { providerCliName } from "../../providers/provider-cli-names";
import { isKnownProvider, listProviders } from "../../providers/provider-names";
import { checkProviderHealth, getProvider, getProviderCapabilities } from "../../providers/registry";
import { ProfileSchema } from "../../profile-schemas";

const removed = ["gemini-cli", "antigravity"];

describe("removed standalone Google providers", () => {
  test("explicit names reject session, capability, health, and model routes with migration guidance", async () => {
    for (const name of removed) {
      expect(isKnownProvider(name)).toBe(false);
      expect(listProviders()).not.toContain(name);
      expect(providerCliName(name)).toBeUndefined();
      const profile = ProfileSchema.safeParse({ provider: name, prompt: "", description: "Legacy profile" });
      expect(profile.success).toBe(false);
      if (!profile.success) expect(profile.error.issues[0]?.message).toMatch(/Update this profile.*declarative PI provider/);
      for (const resolve of [() => getProvider(name), () => getProviderCapabilities(name)]) {
        expect(resolve).toThrow(/Update this profile.*declarative PI provider/);
      }
      await expect(checkProviderHealth(name)).rejects.toThrow(/Update this profile.*declarative PI provider/);
      await expect(fetchProviderModels(name)).rejects.toThrow(/Update this profile.*declarative PI provider/);
    }
  });

  test("paid Google API protocols remain valid for declarative PI definitions", () => {
    for (const api of ["google-generative-ai", "google-vertex"] as const) {
      expect(KNOWN_PI_APIS).toContain(api);
      expect(ProviderDefinitionSchema.safeParse({
        name: `paid-${api}`,
        kind: "pi",
        api,
        baseUrl: "https://example.invalid/v1",
        apiKeyName: "GOOGLE_PAID_API_KEY",
        defaultModel: "test-model",
      }).success).toBe(true);
    }
  });

  test("Cloud Code Assist protocol cannot be selected through a PI definition", () => {
    expect(KNOWN_PI_APIS).not.toContain("google-gemini-cli");
    expect(ProviderDefinitionSchema.safeParse({
      name: "retired-code-assist",
      kind: "pi",
      api: "google-gemini-cli",
      baseUrl: "https://example.invalid/v1",
      apiKeyName: "GOOGLE_PAID_API_KEY",
      defaultModel: "test-model",
    }).success).toBe(false);
  });
});
