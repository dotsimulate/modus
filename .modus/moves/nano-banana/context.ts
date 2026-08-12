import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { MoveContext, MoveApiContext, MoveApiHandler } from "../../../harness/move-types";

const OUTPUTS_DIR = join(import.meta.dirname, "outputs");

const MODEL_MAP: Record<string, string> = {
  "nano-banana-og": "gemini-2.5-flash-image",
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-3.1-flash-image-preview",
};

function ensureOutputsDir(): void {
  if (!existsSync(OUTPUTS_DIR)) {
    mkdirSync(OUTPUTS_DIR, { recursive: true });
  }
}

export async function gather(ctx: MoveContext): Promise<string> {
  const countInput = (ctx.inputs.count as string) ?? "1";
  const freeform = countInput === "custom";
  const count = freeform ? null : Number(countInput);
  const unique = Boolean(ctx.inputs.unique ?? false);
  const modelKey = (ctx.inputs.model as string) ?? "nano-banana-2";
  const modelId = MODEL_MAP[modelKey] ?? MODEL_MAP["nano-banana-2"];

  ensureOutputsDir();

  // Seed instance state
  if (ctx.instanceId) {
    const stateDir = join(ctx.cwd, ".modus/moves/nano-banana/state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, `${ctx.instanceId}.json`),
      JSON.stringify({ count, freeform, unique, model: modelId }, null, 2),
    );
  }

  const apiKey = ctx.secrets.resolve("GEMINI_API_KEY");
  const keyStatus = apiKey ? "configured" : "NOT SET — add GEMINI_API_KEY to ~/.config/agent-dev-zone/secrets.env";

  return [
    `You have access to Nano Banana image generation.`,
    ``,
    `**Token:** \`${ctx.apiToken}\``,
    `**Model:** ${modelKey} (\`${modelId}\`)`,
    `**Images per call:** ${freeform ? "custom (pass count in each generate call)" : count}`,
    `**Unique mode:** ${unique ? "on" : "off"}`,
    `**API key status:** ${keyStatus}`,
    `**Outputs saved to:** ${OUTPUTS_DIR}`,
    ``,
    `## Available operations`,
    ``,
    `- **generate** — Generate image(s). Pass \`prompt\` (required) and \`count\` (optional, default 1, no cap). Each call generates \`count\` images.`,
    `- **list** — List all previously generated images in the outputs folder.`,
    ``,
    `## Instructions`,
    ``,
    freeform
      ? `Custom mode — pass \`count\` in each generate call to control how many images are produced. No cap.`
      : `Each generate call produces ${count} image(s). You can call generate multiple times in a session.`,
    unique
      ? `Unique mode is ON — vary the prompt for each image. Call generate with count=1 multiple times, each with a different prompt variation.`
      : `Unique mode is OFF — all images in a batch use the same prompt.`,
    `After generation, report the file paths back to the user. Images are viewable in the Nano Banana panel.`,
  ].join("\n");
}

async function callNanoBanana(prompt: string, model: string, apiKey: string): Promise<{ imageData: string; mimeType: string } | { error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `Gemini API error (${res.status}): ${text}` };
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ inlineData?: { mimeType: string; data: string }; text?: string }>;
      };
    }>;
  };

  const parts = json.candidates?.[0]?.content?.parts;
  if (!parts) {
    return { error: "No content returned from Gemini API" };
  }

  const imagePart = parts.find((p) => p.inlineData);
  if (!imagePart?.inlineData) {
    return { error: "No image data in response. The model may have returned text only." };
  }

  return { imageData: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType };
}

/** List images with metadata for the widget */
function listImages(): Array<{ filename: string; path: string; createdAt: number }> {
  ensureOutputsDir();
  return readdirSync(OUTPUTS_DIR)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map((f) => {
      const full = join(OUTPUTS_DIR, f);
      const st = statSync(full);
      return { filename: f, path: full, createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export const handlers: Record<string, MoveApiHandler> = {
  generate: async (ctx: MoveApiContext, data: Record<string, unknown>) => {
    const prompt = data.prompt as string;
    if (!prompt) {
      return { ok: false, error: "Missing required field: prompt" };
    }

    ensureOutputsDir();

    const apiKey = ctx.secrets.resolve("GEMINI_API_KEY");
    if (!apiKey) {
      return { ok: false, error: "GEMINI_API_KEY not configured. Add it to ~/.config/agent-dev-zone/secrets.env" };
    }

    const state = (await ctx.state.get<{ count: number | null; freeform: boolean; unique: boolean; model: string }>()) ?? {
      count: 1, freeform: false, unique: false, model: MODEL_MAP["nano-banana-2"],
    };
    const model = state.model;
    // Use op data count if freeform or explicitly passed, otherwise use activation count
    const count = Math.max(1, Number(data.count ?? state.count ?? 1));

    const results: Array<{ path: string; mime: string; name: string }> = [];
    const errors: string[] = [];

    for (let i = 0; i < count; i++) {
      const result = await callNanoBanana(prompt, model, apiKey);
      if ("error" in result) {
        errors.push(result.error);
        continue;
      }

      const ext = result.mimeType === "image/jpeg" ? "jpg" : "png";
      const ts = Date.now();
      const filename = `banana-${ts}-${i}.${ext}`;
      const filepath = join(OUTPUTS_DIR, filename);

      writeFileSync(filepath, Buffer.from(result.imageData, "base64"));
      results.push({ path: filepath, mime: result.mimeType, name: filename });
    }

    if (results.length === 0) {
      return { ok: false, error: errors.join("; ") };
    }

    const msg = [
      `Generated ${results.length} image(s):`,
      ...results.map((file) => `  - ${file.path}`),
      ...(errors.length > 0 ? [`\nErrors (${errors.length}): ${errors.join("; ")}`] : []),
    ].join("\n");

    const lastAssistantSeq = ctx.db.getSessionMessages(ctx.sessionId)
      .findLast((turn) => turn.role === "assistant")?.seq;
    const artifactIds = results.map((file) => ctx.insertArtifact({
      sessionId: ctx.sessionId,
      name: file.name,
      mime: file.mime,
      path: file.path,
      seq: lastAssistantSeq,
      metadata: { moveName: ctx.moveName, op: "generate", prompt },
    }));

    return {
      ok: true,
      message: msg,
      paths: results.map((file) => file.path),
      artifactIds,
    };
  },

  list: async () => {
    const images = listImages();
    if (images.length === 0) {
      return { ok: true, message: JSON.stringify({ images: [] }) };
    }
    return {
      ok: true,
      message: JSON.stringify({ images }),
    };
  },
};
