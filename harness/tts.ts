import {
  getGlobalConfig,
  getStoredGlobalConfig,
  saveGlobalConfig,
  type TextToSpeechConfig,
  type TextToSpeechProviderConfig,
} from "./profiles";
import { resolveSecret } from "./secrets";

export type TtsProviderId = "kokoro" | "zonos2" | "neutts" | "elevenlabs";
export type TtsAudioFormat = "wav" | "mp3" | "pcm";

export type TtsSpeechRequest = {
  text: string;
  voice?: string;
  provider?: TtsProviderId;
  model?: string;
  format?: TtsAudioFormat;
  speed?: number;
  cwd?: string;
};

export type TtsSpeechResult = {
  data: Buffer;
  mime: string;
  extension: string;
  provider: TtsProviderId;
  voice: string;
  model?: string;
};

export type TtsProviderHealth = {
  id: TtsProviderId;
  label: string;
  enabled: boolean;
  configured: boolean;
  ok: boolean;
  url?: string;
  error?: string;
};

const TTS_PROVIDERS = ["kokoro", "zonos2", "neutts", "elevenlabs"] as const satisfies readonly TtsProviderId[];

type ResolvedTtsConfig = Required<Pick<TextToSpeechConfig, "defaultProvider" | "defaultVoice" | "defaultFormat">>
  & Omit<TextToSpeechConfig, "defaultProvider" | "defaultVoice" | "defaultFormat" | "voiceAliases" | "providers">
  & {
    voiceAliases: Record<string, string>;
    providers: Record<TtsProviderId, TextToSpeechProviderConfig>;
  };

const DEFAULT_CONFIG: ResolvedTtsConfig = {
  enabled: true,
  defaultProvider: "kokoro",
  defaultVoice: "am_michael",
  defaultFormat: "wav",
  voiceAliases: {},
  providers: {
    kokoro: {
      enabled: true,
      baseUrl: "http://127.0.0.1:8880",
      model: "kokoro",
    },
    zonos2: {
      enabled: false,
      baseUrl: "http://127.0.0.1:1919",
      model: "zonos2",
    },
    neutts: {
      enabled: false,
      baseUrl: "http://127.0.0.1:8880",
      model: "neutts",
    },
    elevenlabs: {
      enabled: false,
      model: "eleven_multilingual_v2",
      apiKeyEnv: "ELEVENLABS_API_KEY",
      outputFormat: "mp3_44100_128",
    },
  },
};

function trimBaseUrl(url: string | undefined): string | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  return value.replace(/\/+$/, "");
}

function normalizeFormat(value: unknown, fallback: TtsAudioFormat): TtsAudioFormat {
  return value === "mp3" || value === "pcm" || value === "wav" ? value : fallback;
}

function isTtsProviderId(value: unknown): value is TtsProviderId {
  return typeof value === "string" && TTS_PROVIDERS.includes(value as TtsProviderId);
}

export function parseTtsProviderId(value: unknown): TtsProviderId | undefined {
  return isTtsProviderId(value) ? value : undefined;
}

function providerEnabled(provider: TtsProviderId, config: ResolvedTtsConfig): boolean {
  return config.providers?.[provider]?.enabled !== false;
}

function mergeTextToSpeechConfig(raw?: TextToSpeechConfig): ResolvedTtsConfig {
  return {
    ...DEFAULT_CONFIG,
    ...(raw ?? {}),
    defaultProvider: raw?.defaultProvider ?? DEFAULT_CONFIG.defaultProvider,
    defaultVoice: raw?.defaultVoice ?? DEFAULT_CONFIG.defaultVoice,
    defaultFormat: normalizeFormat(raw?.defaultFormat, DEFAULT_CONFIG.defaultFormat),
    voiceAliases: { ...DEFAULT_CONFIG.voiceAliases, ...(raw?.voiceAliases ?? {}) },
    providers: {
      kokoro: { ...DEFAULT_CONFIG.providers.kokoro, ...(raw?.providers?.kokoro ?? {}) },
      zonos2: { ...DEFAULT_CONFIG.providers.zonos2, ...(raw?.providers?.zonos2 ?? {}) },
      neutts: { ...DEFAULT_CONFIG.providers.neutts, ...(raw?.providers?.neutts ?? {}) },
      elevenlabs: { ...DEFAULT_CONFIG.providers.elevenlabs, ...(raw?.providers?.elevenlabs ?? {}) },
    },
  };
}

export function getTextToSpeechConfig(cwd?: string): ResolvedTtsConfig {
  return mergeTextToSpeechConfig(getGlobalConfig(cwd).textToSpeech);
}

export function patchTextToSpeechConfig(patch: TextToSpeechConfig, cwd?: string): ResolvedTtsConfig {
  const global = getStoredGlobalConfig(cwd);
  const current = global.textToSpeech ?? {};
  const providers = { ...(current.providers ?? {}) };
  for (const id of TTS_PROVIDERS) {
    if (patch.providers?.[id]) {
      providers[id] = { ...(current.providers?.[id] ?? {}), ...patch.providers[id] };
    }
  }
  const next: TextToSpeechConfig = {
    ...current,
    ...patch,
    voiceAliases: patch.voiceAliases ?? current.voiceAliases,
    providers,
  };
  saveGlobalConfig({ ...global, textToSpeech: next }, cwd);
  return mergeTextToSpeechConfig(next);
}

function resolveVoice(provider: TtsProviderId, voice: string | undefined, config: ResolvedTtsConfig): string {
  const requested = voice?.trim() || config.defaultVoice;
  const aliases = config.voiceAliases ?? {};
  const providerAlias = aliases[`${provider}:${requested}`];
  if (providerAlias) return providerAlias;
  return aliases[requested] ?? requested;
}

function mediaInfo(format: TtsAudioFormat, contentType?: string | null): { mime: string; extension: string } {
  const ct = ((contentType ?? "").split(";")[0] ?? "").trim().toLowerCase();
  if (ct === "audio/mpeg" || ct === "audio/mp3") return { mime: "audio/mpeg", extension: ".mp3" };
  if (ct === "audio/wav" || ct === "audio/x-wav") return { mime: "audio/wav", extension: ".wav" };
  if (ct === "audio/pcm" || ct === "application/octet-stream") return { mime: "audio/pcm", extension: ".pcm" };
  if (format === "mp3") return { mime: "audio/mpeg", extension: ".mp3" };
  if (format === "pcm") return { mime: "audio/pcm", extension: ".pcm" };
  return { mime: "audio/wav", extension: ".wav" };
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, 800);
}

function headersWithAuth(apiKeyEnv?: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKeyEnv) {
    const key = resolveSecret(apiKeyEnv);
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function requireBaseUrl(provider: TtsProviderId, value: string | undefined): string {
  const baseUrl = trimBaseUrl(value);
  if (!baseUrl) throw new Error(`${provider} TTS baseUrl is not configured`);
  return baseUrl;
}

async function callOpenAiCompatible(
  provider: "kokoro" | "zonos2",
  req: TtsSpeechRequest,
  config: ResolvedTtsConfig,
): Promise<TtsSpeechResult> {
  const providerConfig = config.providers?.[provider] ?? {};
  const baseUrl = requireBaseUrl(provider, providerConfig.baseUrl);
  const format = normalizeFormat(req.format, config.defaultFormat);
  const voice = resolveVoice(provider, req.voice, config);
  const model = req.model ?? providerConfig.model ?? provider;

  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: "POST",
    headers: headersWithAuth(providerConfig.apiKeyEnv),
    body: JSON.stringify({
      model,
      input: req.text,
      voice,
      response_format: format,
      ...(typeof req.speed === "number" ? { speed: req.speed } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`${provider} TTS failed: ${response.status} ${await readError(response)}`.trim());
  }

  const info = mediaInfo(format, response.headers.get("content-type"));
  return {
    data: Buffer.from(await response.arrayBuffer()),
    ...info,
    provider,
    voice,
    model,
  };
}

async function callNeuTts(req: TtsSpeechRequest, config: ResolvedTtsConfig): Promise<TtsSpeechResult> {
  const provider = "neutts" as const;
  const providerConfig = config.providers?.neutts ?? {};
  const baseUrl = requireBaseUrl(provider, providerConfig.baseUrl);
  const voice = resolveVoice(provider, req.voice, config);
  const response = await fetch(`${baseUrl}/v1/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: voice, text: req.text, store: false }),
  });
  if (!response.ok) {
    throw new Error(`neutts TTS failed: ${response.status} ${await readError(response)}`.trim());
  }
  const info = mediaInfo("wav", response.headers.get("content-type"));
  return {
    data: Buffer.from(await response.arrayBuffer()),
    ...info,
    provider,
    voice,
    model: providerConfig.model,
  };
}

async function callElevenLabs(req: TtsSpeechRequest, config: ResolvedTtsConfig): Promise<TtsSpeechResult> {
  const provider = "elevenlabs" as const;
  const providerConfig = config.providers?.elevenlabs ?? {};
  const apiKeyEnv = providerConfig.apiKeyEnv ?? "ELEVENLABS_API_KEY";
  const apiKey = resolveSecret(apiKeyEnv);
  if (!apiKey) throw new Error(`${apiKeyEnv} is not configured`);

  const voice = resolveVoice(provider, req.voice, config);
  const model = req.model ?? providerConfig.model ?? "eleven_multilingual_v2";
  const outputFormat = providerConfig.outputFormat ?? "mp3_44100_128";

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?${new URLSearchParams({ output_format: outputFormat })}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: req.text,
      model_id: model,
      voice_settings: {
        stability: providerConfig.stability ?? 0.5,
        similarity_boost: providerConfig.similarityBoost ?? 0.75,
        style: providerConfig.style ?? 0,
        ...(typeof req.speed === "number" ? { speed: req.speed } : {}),
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`elevenlabs TTS failed: ${response.status} ${await readError(response)}`.trim());
  }
  const info = mediaInfo("mp3", response.headers.get("content-type"));
  return {
    data: Buffer.from(await response.arrayBuffer()),
    ...info,
    provider,
    voice,
    model,
  };
}

export async function synthesizeSpeech(req: TtsSpeechRequest): Promise<TtsSpeechResult> {
  const text = req.text?.trim();
  if (!text) throw new Error("text is required");

  const config = getTextToSpeechConfig(req.cwd);
  if (config.enabled === false) throw new Error("text-to-speech is disabled");

  const provider = req.provider ?? config.defaultProvider;
  if (!providerEnabled(provider, config)) throw new Error(`text-to-speech provider is disabled: ${provider}`);

  if (provider === "kokoro" || provider === "zonos2") return callOpenAiCompatible(provider, req, config);
  if (provider === "neutts") return callNeuTts(req, config);
  return callElevenLabs(req, config);
}

async function probeUrl(url: string | undefined): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = trimBaseUrl(url);
  if (!baseUrl) return { ok: false, error: "baseUrl not configured" };
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
    if (response.ok) return { ok: true };
    return { ok: false, error: `HTTP ${response.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getTextToSpeechHealth(cwd?: string): Promise<TtsProviderHealth[]> {
  const config = getTextToSpeechConfig(cwd);
  return Promise.all(TTS_PROVIDERS.map(async (id) => {
    const providerConfig = config.providers?.[id] ?? {};
    const label = id === "zonos2" ? "ZONOS2" : id === "elevenlabs" ? "ElevenLabs" : id;
    const enabled = providerConfig.enabled !== false;
    if (id === "elevenlabs") {
      const apiKeyEnv = providerConfig.apiKeyEnv ?? "ELEVENLABS_API_KEY";
      const configured = !!resolveSecret(apiKeyEnv);
      return {
        id,
        label,
        enabled,
        configured,
        ok: enabled && configured,
        error: configured ? undefined : `${apiKeyEnv} not set`,
      };
    }
    const url = trimBaseUrl(providerConfig.baseUrl);
    const probe = enabled ? await probeUrl(url) : { ok: false, error: "disabled" };
    return {
      id,
      label,
      enabled,
      configured: !!url,
      ok: enabled && probe.ok,
      url,
      error: probe.ok ? undefined : probe.error,
    };
  }));
}

export async function listTextToSpeechVoices(provider?: TtsProviderId, cwd?: string): Promise<{ provider: TtsProviderId; voices: string[] }> {
  const config = getTextToSpeechConfig(cwd);
  const id = provider ?? config.defaultProvider;
  if (id === "kokoro") {
    const baseUrl = requireBaseUrl(id, config.providers?.kokoro?.baseUrl);
    const response = await fetch(`${baseUrl}/v1/audio/voices`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`kokoro voices failed: ${response.status}`);
    const body = await response.json() as { voices?: unknown };
    return { provider: id, voices: Array.isArray(body.voices) ? body.voices.filter((v): v is string => typeof v === "string") : [] };
  }
  if (id === "neutts") {
    const baseUrl = requireBaseUrl(id, config.providers?.neutts?.baseUrl);
    const response = await fetch(`${baseUrl}/v1/voices`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) throw new Error(`neutts voices failed: ${response.status}`);
    const body = await response.json() as { voices?: unknown };
    return { provider: id, voices: Array.isArray(body.voices) ? body.voices.filter((v): v is string => typeof v === "string") : [] };
  }
  return { provider: id, voices: Object.keys(config.voiceAliases ?? {}) };
}

export function openAiSpeechToTtsRequest(body: Record<string, unknown>, cwd?: string): TtsSpeechRequest {
  return {
    cwd,
    text: String(body.input ?? body.text ?? ""),
    voice: typeof body.voice === "string" ? body.voice : undefined,
    provider: parseTtsProviderId(body.provider),
    model: typeof body.model === "string" ? body.model : undefined,
    format: normalizeFormat(body.response_format, getTextToSpeechConfig(cwd).defaultFormat),
    speed: typeof body.speed === "number" ? body.speed : undefined,
  };
}
