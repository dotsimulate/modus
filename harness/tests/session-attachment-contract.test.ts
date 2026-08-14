import { describe, expect, test } from "bun:test";
import { InteractRequestSchema, SendMessageRequestSchema, IMAGE_ATTACHMENT_MEDIA_TYPES } from "../session-schemas";
import { validate } from "../profile-schemas";

describe("external image attachment wire contract", () => {
  test("accepts the documented MIME types on both message endpoints", () => {
    for (const mediaType of IMAGE_ATTACHMENT_MEDIA_TYPES) {
      const body = {
        prompt: "describe this",
        subscribe: false,
        attachments: [{ type: "image", mediaType, data: "iVBORw==", name: "sample.png" }],
      };
      expect(validate(InteractRequestSchema, body).ok).toBe(true);
      expect(validate(SendMessageRequestSchema, body).ok).toBe(true);
    }
  });

  test("rejects unsupported MIME types and data-URL/non-base64 payloads", () => {
    for (const attachment of [
      { type: "image", mediaType: "image/svg+xml", data: "PHN2Zz4=" },
      { type: "image", mediaType: "image/png", data: "data:image/png;base64,iVBORw==" },
      { type: "image", mediaType: "image/png", data: "not base64" },
    ]) {
      expect(validate(SendMessageRequestSchema, { prompt: "describe", attachments: [attachment] }).ok).toBe(false);
    }
  });
});
