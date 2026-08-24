# Text To Speech

Modus routes speech synthesis through a shared server-side provider layer, so the
harness API and the standalone LAN gateway resolve the same provider, voice, and
format config.

**Modus does not ship a speech engine.** Every provider below is a server *you*
run or subscribe to. Until one is reachable, `/api/tts/health` reports it
unconfigured and synthesis fails — that is the expected state on a fresh install,
not a defect. Speech is opt-in infrastructure, like an MCP server or a provider
CLI.

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

## Reaching TTS from a move or action

There is **no `ctx.tts` binding on the Harness Context.** Authored moves and
actions reach speech the same way any other client does — an HTTP POST to the
harness's own compatibility route:

```ts
const res = await fetch("http://127.0.0.1:3777/v1/audio/speech", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: script, voice: "am_michael", response_format: "wav" }),
});
```

Use the harness route rather than a provider container's address directly. That
is the whole point of the layer: the provider, voice aliases, and format stay in
one config that the user can repoint without editing authored content. An action
that hardcodes `http://<some-lan-ip>:8880` has opted out of every one of those
switches and will break when the provider moves.

To attach the result to a turn, write the bytes to `ctx.artifactPath(name)` and
call `ctx.attachArtifact({ sessionId, seq, path, name, mime, previewText })`.
That is how audio lands at the bottom of an assistant turn.

## LAN Gateway

For tools on other computers that already call a local Kokoro-style endpoint, run
the standalone gateway from the `harness/` directory of your Modus checkout:

```bash
cd harness
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
