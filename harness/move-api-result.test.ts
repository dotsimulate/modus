import { describe, expect, test } from "bun:test";
import { formatMoveApiResultText } from "./move-api-result";

describe("formatMoveApiResultText", () => {
  test("plain ok with no message and no extras renders OK", () => {
    expect(formatMoveApiResultText({ ok: true })).toBe("OK");
  });

  test("message-only result renders the message alone", () => {
    expect(formatMoveApiResultText({ ok: true, message: "pong" })).toBe("pong");
  });

  test("extra keys survive as a JSON block instead of being dropped", () => {
    const text = formatMoveApiResultText({
      ok: true,
      ms: 2832,
      oneShotId: "os-1",
      usage: { totalTokens: 250 },
    });
    expect(text.startsWith("```json")).toBe(true);
    expect(text).toContain('"ms": 2832');
    expect(text).toContain('"oneShotId": "os-1"');
    expect(text).toContain('"totalTokens": 250');
    expect(text).not.toContain('"ok"');
  });

  test("message and extras render message first, then the block", () => {
    const text = formatMoveApiResultText({ ok: true, message: "done", count: 3 });
    expect(text.startsWith("done\n```json")).toBe(true);
    expect(text).toContain('"count": 3');
    expect(text).not.toContain('"message"');
  });

  test("error result leads with the error and keeps extra detail keys", () => {
    const text = formatMoveApiResultText({ ok: false, error: "boom", attemptedUrl: "http://x" });
    expect(text.startsWith("boom\n```json")).toBe(true);
    expect(text).toContain('"attemptedUrl"');
    expect(text).not.toContain('"error"');
  });

  test("error result with no error text falls back to Unknown error", () => {
    expect(formatMoveApiResultText({ ok: false })).toBe("Unknown error");
  });

  test("undefined-valued keys are not serialized", () => {
    expect(formatMoveApiResultText({ ok: true, message: "m", usage: undefined })).toBe("m");
  });
});
