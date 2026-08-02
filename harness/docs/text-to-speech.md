# Text To Speech

Modus routes speech synthesis through a shared server-side provider layer. Moves,
actions, the harness API, and the standalone LAN gateway all use the same config.

## Providers

Configured provider ids:

- `kokoro`: OpenAI-compatible local speech endpoint, default `http://127.0.0.1:8880`.
- `zonos2`: OpenAI-compatible local speech endpoint, default `http://127.0.0.1:1919`.
- `neutts`: NeuTTS local endpoint, default `http://127.0.0.1:8880`.
- `elevenlabs`: hosted ElevenLabs text-to-speech using a configured secret env name.

The current default remains Kokoro so existing local setups continue to work.
ZONOS2 is configured but disabled until its local server is running.

## Harness API

These routes are available on the main Modus harness server:

```text
GET  /api/tts/config
PATCH /api/tts/config
GET  /api/tts/health
GET  /api/tts/voices?provider=zonos2
POST /api/tts/speech
POST /v1/audio/speech
GET  /v1/audio/voices
GET  /v1/models
```

`POST /v1/audio/speech` accepts the OpenAI-style body:

```json
{
  "model": "zonos2",
  "input": "Say this out loud.",
  "voice": "am_michael",
  "response_format": "wav"
}
```

Modus also accepts a `provider` field for explicit routing:

```json
{
  "provider": "zonos2",
  "input": "Say this with ZONOS2.",
  "voice": "am_michael",
  "response_format": "wav"
}
```

## LAN Gateway

For tools on other computers that already call a local Kokoro-style endpoint, run
the standalone gateway:

```bash
cd /home/dot/dev/infra/agent_dev_zone/harness
bun run tts:gateway
```

Defaults:

```text
TTS_GATEWAY_HOST=0.0.0.0
TTS_GATEWAY_PORT=8880
```

The gateway exposes the same compatibility route:

```text
POST http://<modus-host>:8880/v1/audio/speech
```

Do not run the gateway on `8880` while a Kokoro or NeuTTS container is also bound
to host port `8880`. When migrating, run the provider server on its own port
such as ZONOS2 on `1919`, then let the gateway own `8880` for LAN clients.

## Switching To ZONOS2

Official upstream local-server quick start, as of June 14, 2026:

```text
Platform support: Linux x86_64 only.
Requires an NVIDIA GPU with a CUDA toolkit version that matches the installed driver.
Default server address: http://localhost:1919
```

Launch the upstream server with:

```bash
git clone https://github.com/Zyphra/ZONOS2.git
cd ZONOS2
uv sync
uv run python -m zonos2 --model-path Zyphra/ZONOS2 --tts-default-voices-dir ./default_voices/
```

If this machine does not satisfy the upstream NVIDIA CUDA requirement, do not switch
Modus to `zonos2` locally yet. Keep the current provider active or run ZONOS2 on a
separate supported Linux host and point the `zonos2.baseUrl` there instead.

Once the ZONOS2 server is actually serving on port `1919`, patch Modus config:

```bash
curl -X PATCH "http://127.0.0.1:3777/api/tts/config" \
  -H "Content-Type: application/json" \
  -d '{
    "defaultProvider": "zonos2",
    "defaultVoice": "am_michael",
    "providers": {
      "zonos2": {
        "enabled": true,
        "baseUrl": "http://127.0.0.1:1919",
        "model": "zonos2"
      }
    }
  }'
```

Check health:

```bash
curl "http://127.0.0.1:3777/api/tts/health"
```

Then test synthesis:

```bash
curl -o /tmp/modus-tts.wav \
  -X POST "http://127.0.0.1:3777/v1/audio/speech" \
  -H "Content-Type: application/json" \
  -d '{"input":"ZONOS2 is now the default Modus voice.","voice":"am_michael","response_format":"wav"}'
```

## Migration Guidance For Other Projects

Projects on the LAN should target the compatibility endpoint, not a provider
container directly:

```text
POST http://<modus-host>:8880/v1/audio/speech
```

Use the OpenAI-compatible request shape:

```json
{
  "input": "Text to speak",
  "voice": "am_michael",
  "response_format": "wav"
}
```

That lets Modus switch Kokoro, ZONOS2, NeuTTS, or ElevenLabs behind the endpoint
without changing those projects again.
