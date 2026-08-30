/**
 * Lift pictures out of tool-result payloads.
 *
 * Claude sends `{ type: "image", source: { type: "base64", data } }` blocks.
 * Grok's read_file of an image sends `{ type: "ReadFile", ImageContent: { data } }`
 * (sometimes JSON-stringified). If that envelope is left as text, the transcript
 * shows a truncated base64 wall instead of the picture.
 */

export type PeeledToolImage = {
  mediaType: string;
  data: string;
};

export type PeeledToolResult = {
  text: string;
  images: PeeledToolImage[];
};

function isByte(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

function bytesToString(bytes: number[]): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(bytes));
  } catch {
    return bytes.map((b) => String.fromCharCode(b)).join("");
  }
}

function bytesToBase64(bytes: number[]): string {
  const u8 = Uint8Array.from(bytes);
  let binary = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    binary += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function stripDataUrl(data: string): string {
  const match = /^data:[^;]+;base64,(.+)$/s.exec(data.trim());
  return match?.[1] ?? data;
}

function sniffMediaType(data: string, hinted?: unknown): string {
  if (typeof hinted === "string" && hinted.trim()) {
    const hint = hinted.trim().toLowerCase();
    if (hint.startsWith("image/")) return hint;
    if (hint === "jpg" || hint === "jpeg") return "image/jpeg";
    if (hint === "png" || hint === "gif" || hint === "webp") return `image/${hint}`;
    if (hint === "svg" || hint === "svg+xml") return "image/svg+xml";
  }
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("iVBOR")) return "image/png";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  if (data.startsWith("PHN2Zy") || data.startsWith("PD94bWwg")) return "image/svg+xml";
  return "image/png";
}

function imageFromRecord(obj: Record<string, unknown>): PeeledToolImage | null {
  const source = obj.source;
  if (obj.type === "image" && source && typeof source === "object" && !Array.isArray(source)) {
    const src = source as Record<string, unknown>;
    if (typeof src.data === "string" && src.data) {
      const data = stripDataUrl(src.data);
      return { mediaType: sniffMediaType(data, src.media_type ?? src.mediaType), data };
    }
  }

  if ((obj.type === "image" || obj.type === "Image") && typeof obj.data === "string" && obj.data.length > 24) {
    const data = stripDataUrl(obj.data);
    return { mediaType: sniffMediaType(data, obj.mimeType ?? obj.media_type ?? obj.mediaType), data };
  }

  const imageContent = obj.ImageContent ?? obj.imageContent ?? obj.image_content;
  if (imageContent && typeof imageContent === "object" && !Array.isArray(imageContent)) {
    const payload = imageContent as Record<string, unknown>;
    let data: string | undefined;
    if (typeof payload.data === "string" && payload.data) data = stripDataUrl(payload.data);
    else if (Array.isArray(payload.data) && payload.data.length > 0 && payload.data.every(isByte)) {
      data = bytesToBase64(payload.data as number[]);
    }
    if (data && data.length > 24) {
      return {
        mediaType: sniffMediaType(data, payload.mimeType ?? payload.media_type ?? payload.mime_type ?? payload.format),
        data,
      };
    }
  }
  return null;
}

/**
 * Walk any tool-result shape and return caption text plus images. The base64
 * never belongs in `text` — that is what used to get sliced mid-payload.
 */
export function peelToolResultImages(value: unknown): PeeledToolResult {
  if (value == null) return { text: "", images: [] };

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return peelToolResultImages(JSON.parse(trimmed));
      } catch {
        return { text: value, images: [] };
      }
    }
    return { text: value, images: [] };
  }

  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isByte)) {
      const bytes = value as number[];
      if (bytes[0] === 0xff && bytes[1] === 0xd8) {
        return { text: "", images: [{ mediaType: "image/jpeg", data: bytesToBase64(bytes) }] };
      }
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { text: "", images: [{ mediaType: "image/png", data: bytesToBase64(bytes) }] };
      }
      return { text: bytesToString(bytes), images: [] };
    }
    const images: PeeledToolImage[] = [];
    const parts: string[] = [];
    for (const entry of value) {
      const nested = peelToolResultImages(
        entry && typeof entry === "object" && !Array.isArray(entry) && "content" in entry && (entry as { type?: string }).type !== "image"
          ? (entry as { content: unknown }).content
          : entry,
      );
      images.push(...nested.images);
      if (nested.text) parts.push(nested.text);
    }
    return { text: parts.join("\n"), images };
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const direct = imageFromRecord(obj);
    if (direct) return { text: "", images: [direct] };

    if (obj.type === "text" && typeof obj.text === "string") return { text: obj.text, images: [] };
    if (typeof obj.OkayOutput === "string") return peelToolResultImages(obj.OkayOutput);
    if (typeof obj.ErrorOutput === "string") return peelToolResultImages(obj.ErrorOutput);
    if (typeof obj.output_for_prompt === "string") return peelToolResultImages(obj.output_for_prompt);
    if (typeof obj.output === "string" || Array.isArray(obj.output) || (obj.output && typeof obj.output === "object")) {
      return peelToolResultImages(obj.output);
    }

    const fileContent = obj.FileContent;
    if (fileContent && typeof fileContent === "object" && !Array.isArray(fileContent)) {
      const content = (fileContent as Record<string, unknown>).content;
      if (typeof content === "string") return { text: content, images: [] };
    }

    if (obj.content != null && obj.content !== obj) return peelToolResultImages(obj.content);

    try {
      return { text: JSON.stringify(value), images: [] };
    } catch {
      return { text: String(value), images: [] };
    }
  }

  return { text: String(value), images: [] };
}

/** Claude-shaped tool_result content: a string, or text/image blocks. */
export function claudeToolResultContent(value: unknown): string | Array<Record<string, unknown>> {
  const peeled = peelToolResultImages(value);
  if (peeled.images.length === 0) return peeled.text;
  const blocks: Array<Record<string, unknown>> = [];
  if (peeled.text) blocks.push({ type: "text", text: peeled.text });
  for (const image of peeled.images) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    });
  }
  return blocks;
}
