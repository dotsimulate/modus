import { useCallback, useEffect, useMemo, useState } from "react";
import type { TextToSpeechConfig, TextToSpeechProviderId, TtsProviderHealth } from "../../../sdk/index";
import { modus } from "../modusClient";
import { useProfiles } from "../providers/ProfileContext";
import { WidgetEmptyState } from "./widget-components";
import type { WidgetProps, WidgetBase } from "./types";
import "../styles/components/tts-settings-widget.css";

type TtsSettingsWidgetConfig = WidgetBase & {
  type: "tts-settings";
};

const PROVIDERS: TextToSpeechProviderId[] = ["kokoro", "zonos2", "neutts", "elevenlabs"];

const PROVIDER_LABELS: Record<TextToSpeechProviderId, string> = {
  kokoro: "Kokoro",
  zonos2: "ZONOS2",
  neutts: "NeuTTS",
  elevenlabs: "ElevenLabs",
};

function defaultProviderConfig(provider: TextToSpeechProviderId) {
  if (provider === "kokoro") return { enabled: true, baseUrl: "http://127.0.0.1:8880", model: "kokoro" };
  if (provider === "zonos2") return { enabled: false, baseUrl: "http://127.0.0.1:1919", model: "zonos2" };
  if (provider === "neutts") return { enabled: false, baseUrl: "http://127.0.0.1:8880", model: "neutts" };
  return { enabled: false, model: "eleven_multilingual_v2", apiKeyEnv: "ELEVENLABS_API_KEY", outputFormat: "mp3_44100_128" };
}

function mergeDefaults(config: TextToSpeechConfig): TextToSpeechConfig {
  return {
    enabled: config.enabled ?? true,
    defaultProvider: config.defaultProvider ?? "kokoro",
    defaultVoice: config.defaultVoice ?? "am_michael",
    defaultFormat: config.defaultFormat ?? "wav",
    voiceAliases: config.voiceAliases ?? {},
    providers: {
      kokoro: { ...defaultProviderConfig("kokoro"), ...(config.providers?.kokoro ?? {}) },
      zonos2: { ...defaultProviderConfig("zonos2"), ...(config.providers?.zonos2 ?? {}) },
      neutts: { ...defaultProviderConfig("neutts"), ...(config.providers?.neutts ?? {}) },
      elevenlabs: { ...defaultProviderConfig("elevenlabs"), ...(config.providers?.elevenlabs ?? {}) },
    },
  };
}

function healthByProvider(health: TtsProviderHealth[]): Record<string, TtsProviderHealth> {
  return Object.fromEntries(health.map((item) => [item.id, item]));
}

export default function TtsSettingsWidget(_props: WidgetProps<TtsSettingsWidgetConfig>) {
  const { activeCwd } = useProfiles();
  const [config, setConfig] = useState<TextToSpeechConfig | null>(null);
  const [health, setHealth] = useState<TtsProviderHealth[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextConfig, nextHealth] = await Promise.all([
        modus.getTextToSpeechConfig(activeCwd),
        modus.getTextToSpeechHealth(activeCwd),
      ]);
      setConfig(mergeDefaults(nextConfig));
      setHealth(nextHealth);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load TTS config");
    } finally {
      setLoading(false);
    }
  }, [activeCwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const healthMap = useMemo(() => healthByProvider(health), [health]);

  function patchConfig(patch: TextToSpeechConfig) {
    setConfig((prev) => mergeDefaults({ ...(prev ?? {}), ...patch }));
  }

  function patchProvider(provider: TextToSpeechProviderId, patch: Record<string, unknown>) {
    setConfig((prev) => {
      const current = mergeDefaults(prev ?? {});
      return mergeDefaults({
        ...current,
        providers: {
          ...current.providers,
          [provider]: {
            ...(current.providers?.[provider] ?? {}),
            ...patch,
          },
        },
      });
    });
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await modus.patchTextToSpeechConfig(config, activeCwd);
      setConfig(mergeDefaults(saved));
      setHealth(await modus.getTextToSpeechHealth(activeCwd));
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to save TTS config");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !config) return <WidgetEmptyState>loading TTS settings...</WidgetEmptyState>;
  if (!config) return <WidgetEmptyState>{error ?? "TTS settings unavailable"}</WidgetEmptyState>;

  return (
    <div className="tts-settings-widget">
      <div className="tts-settings-header">
        <div>
          <div className="tts-settings-title">text to speech</div>
          <div className="tts-settings-subtitle">shared server-side provider routing</div>
        </div>
        <div className="tts-settings-actions">
          <button type="button" onClick={() => void load()} disabled={loading || saving}>refresh</button>
          <button type="button" onClick={() => void save()} disabled={saving}>{saving ? "saving" : "save"}</button>
        </div>
      </div>

      {error && <div className="tts-settings-error">{error}</div>}

      <div className="tts-settings-grid">
        <label>
          <span>enabled</span>
          <input
            type="checkbox"
            checked={config.enabled !== false}
            onChange={(event) => patchConfig({ enabled: event.target.checked })}
          />
        </label>
        <label>
          <span>default provider</span>
          <select
            value={config.defaultProvider ?? "kokoro"}
            onChange={(event) => patchConfig({ defaultProvider: event.target.value as TextToSpeechProviderId })}
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>{PROVIDER_LABELS[provider]}</option>
            ))}
          </select>
        </label>
        <label>
          <span>default voice</span>
          <input
            value={config.defaultVoice ?? ""}
            onChange={(event) => patchConfig({ defaultVoice: event.target.value })}
          />
        </label>
        <label>
          <span>format</span>
          <select
            value={config.defaultFormat ?? "wav"}
            onChange={(event) => patchConfig({ defaultFormat: event.target.value as "wav" | "mp3" | "pcm" })}
          >
            <option value="wav">wav</option>
            <option value="mp3">mp3</option>
            <option value="pcm">pcm</option>
          </select>
        </label>
      </div>

      <div className="tts-provider-list">
        {PROVIDERS.map((provider) => {
          const providerConfig = config.providers?.[provider] ?? {};
          const status = healthMap[provider];
          return (
            <div className="tts-provider-row" key={provider}>
              <div className="tts-provider-head">
                <label className="tts-provider-toggle">
                  <input
                    type="checkbox"
                    checked={providerConfig.enabled !== false}
                    onChange={(event) => patchProvider(provider, { enabled: event.target.checked })}
                  />
                  <span>{PROVIDER_LABELS[provider]}</span>
                </label>
                <span className={`tts-provider-status ${status?.ok ? "tts-provider-status--ok" : "tts-provider-status--bad"}`}>
                  {status?.ok ? "online" : status?.error ?? "offline"}
                </span>
              </div>
              <div className="tts-provider-fields">
                {provider !== "elevenlabs" && (
                  <label>
                    <span>base url</span>
                    <input
                      value={providerConfig.baseUrl ?? ""}
                      onChange={(event) => patchProvider(provider, { baseUrl: event.target.value })}
                    />
                  </label>
                )}
                <label>
                  <span>model</span>
                  <input
                    value={providerConfig.model ?? ""}
                    onChange={(event) => patchProvider(provider, { model: event.target.value })}
                  />
                </label>
                {provider === "elevenlabs" && (
                  <>
                    <label>
                      <span>api key env</span>
                      <input
                        value={providerConfig.apiKeyEnv ?? ""}
                        onChange={(event) => patchProvider(provider, { apiKeyEnv: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>output</span>
                      <input
                        value={providerConfig.outputFormat ?? ""}
                        onChange={(event) => patchProvider(provider, { outputFormat: event.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
