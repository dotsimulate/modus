/**
 * Explicit local provider detection.
 *
 * Nothing calls this during startup or health polling. A caller must opt in,
 * and successful probes are returned as definition proposals only; they are
 * never registered or written to disk.
 */

import type { ProviderDefinition } from "./provider-definition";

export type DetectedProvider = {
  definition: ProviderDefinition;
  modelIds: string[];
};

type DetectionTarget = {
  name: string;
  label: string;
  baseUrl: string;
};

export const LOCAL_PROVIDER_DETECTION_TARGETS: DetectionTarget[] = [
  { name: "lmstudio", label: "LM Studio (local)", baseUrl: "http://127.0.0.1:1234/v1" },
  { name: "ollama-local", label: "Ollama (local)", baseUrl: "http://127.0.0.1:11434/v1" },
  { name: "litellm-local", label: "LiteLLM (local)", baseUrl: "http://127.0.0.1:4000/v1" },
  { name: "vllm", label: "vLLM (local)", baseUrl: "http://127.0.0.1:8000/v1" },
  { name: "llamacpp", label: "llama.cpp (local)", baseUrl: "http://127.0.0.1:8080/v1" },
  { name: "openai-gateway", label: "OpenAI-compatible gateway", baseUrl: "http://127.0.0.1:8317/v1" },
];

export function modelIdsFromDetectionResponse(value: unknown): string[] | null {
  if (!value || typeof value !== "object" || !("data" in value)) return null;
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const id = (entry as { id?: unknown }).id;
      return typeof id === "string" && id.trim() ? id : null;
    })
    .filter((id): id is string => id !== null);
  return ids.length > 0 ? ids : null;
}

export async function detectLocalProviders(
  fetcher: typeof fetch = fetch,
  timeoutMs = 1500,
): Promise<DetectedProvider[]> {
  const detected = await Promise.all(LOCAL_PROVIDER_DETECTION_TARGETS.map(async (target) => {
    try {
      const response = await fetcher(`${target.baseUrl}/models`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const modelIds = modelIdsFromDetectionResponse(await response.json());
      if (!modelIds) return null;
      const proposal: DetectedProvider = {
        definition: {
          name: target.name,
          label: target.label,
          kind: "pi",
          api: "openai-completions",
          baseUrl: target.baseUrl,
          defaultModel: modelIds[0]!,
          input: ["text", "image"],
        },
        modelIds,
      };
      return proposal;
    } catch {
      return null;
    }
  }));
  return detected.filter((entry): entry is DetectedProvider => entry !== null);
}
