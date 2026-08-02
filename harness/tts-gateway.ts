import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  getTextToSpeechConfig,
  getTextToSpeechHealth,
  listTextToSpeechVoices,
  openAiSpeechToTtsRequest,
  parseTtsProviderId,
  synthesizeSpeech,
} from "./tts";

const PORT = Number(process.env.TTS_GATEWAY_PORT ?? 8880);
const HOST = process.env.TTS_GATEWAY_HOST ?? "0.0.0.0";

const app = new Hono();
app.use("*", cors());

function audioResponse(result: Awaited<ReturnType<typeof synthesizeSpeech>>): Response {
  return new Response(result.data, {
    headers: {
      "Content-Type": result.mime,
      "Content-Disposition": `inline; filename="speech${result.extension}"`,
      "X-TTS-Provider": result.provider,
      "X-TTS-Voice": result.voice,
    },
  });
}

app.get("/health", async (c) => {
  const health = await getTextToSpeechHealth();
  return c.json({
    status: health.some((provider) => provider.ok) ? "healthy" : "degraded",
    defaultProvider: getTextToSpeechConfig().defaultProvider,
    providers: health,
  });
});

app.get("/api/tts/config", (c) => c.json(getTextToSpeechConfig()));
app.get("/api/tts/health", async (c) => c.json(await getTextToSpeechHealth()));
app.get("/api/tts/voices", async (c) => {
  try {
    return c.json(await listTextToSpeechVoices(parseTtsProviderId(c.req.query("provider"))));
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to list voices" }, 400);
  }
});

app.post("/api/tts/speech", async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    const result = await synthesizeSpeech({
      text: String(body.text ?? body.input ?? ""),
      voice: typeof body.voice === "string" ? body.voice : undefined,
      provider: parseTtsProviderId(body.provider),
      model: typeof body.model === "string" ? body.model : undefined,
      format: body.format === "mp3" || body.format === "pcm" || body.format === "wav" ? body.format : undefined,
      speed: typeof body.speed === "number" ? body.speed : undefined,
    });
    return audioResponse(result);
  } catch (err: any) {
    return c.json({ error: err.message ?? "TTS failed" }, 400);
  }
});

app.post("/v1/audio/speech", async (c) => {
  try {
    const body = await c.req.json() as Record<string, unknown>;
    return audioResponse(await synthesizeSpeech(openAiSpeechToTtsRequest(body)));
  } catch (err: any) {
    return c.json({ error: err.message ?? "TTS failed" }, 400);
  }
});

app.get("/v1/audio/voices", async (c) => {
  try {
    return c.json(await listTextToSpeechVoices());
  } catch (err: any) {
    return c.json({ error: err.message ?? "failed to list voices" }, 400);
  }
});

app.get("/v1/models", (c) => {
  const config = getTextToSpeechConfig();
  return c.json({
    object: "list",
    data: Object.entries(config.providers ?? {})
      .filter(([, provider]) => provider?.enabled !== false)
      .map(([id, provider]) => ({
        id: provider?.model ?? id,
        object: "model",
        created: 0,
        owned_by: id,
      })),
  });
});

Bun.serve({
  port: PORT,
  hostname: HOST,
  fetch: app.fetch,
});

console.log(`[tts-gateway] listening on http://${HOST}:${PORT}`);
