import { describe, expect, test } from "bun:test";
import { formatMoveApiResultText, parseMoveApiResultText } from "./move-api-result";

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

describe("parseMoveApiResultText", () => {
  test("round-trips a successful result with prose and structured extras", () => {
    const original = {
      ok: true,
      message: "generated",
      paths: ["a.png", "b.png"],
      usage: { totalTokens: 42 },
    };
    const text = formatMoveApiResultText(original);
    expect(parseMoveApiResultText(text, true)).toEqual(original);
    expect(formatMoveApiResultText(parseMoveApiResultText(text, true))).toBe(text);
  });

  test("keeps formatter fallbacks canonical when there are no extras", () => {
    expect(parseMoveApiResultText("OK", true)).toEqual({ ok: true });
    expect(parseMoveApiResultText("Unknown error", false)).toEqual({ ok: false });
  });

  test("round-trips an error result with detail keys", () => {
    const original = { ok: false, error: "boom", attemptedUrl: "http://x" };
    const text = formatMoveApiResultText(original);
    expect(parseMoveApiResultText(text, false)).toEqual(original);
    expect(formatMoveApiResultText(parseMoveApiResultText(text, false))).toBe(text);
  });

  test("treats a malformed trailing JSON fence as prose", () => {
    const text = "result\n```json\n{nope}\n```";
    expect(parseMoveApiResultText(text, true)).toEqual({ ok: true, message: text });
  });

  test("peels a Grok MCP OkayOutput envelope before parsing the move-api body", () => {
    const body = formatMoveApiResultText({
      ok: true,
      message: "Opening TODO\\live-html-smokes\\smoke.html",
      path: "D:\\TOOLSHELF\\modus\\TODO\\live-html-smokes\\smoke.html",
    });
    const envelope = JSON.stringify({
      type: "MCP",
      tool_name: "modus_submit",
      server_name: "modus",
      output: { OkayOutput: body },
    });
    expect(parseMoveApiResultText(envelope, true)).toEqual({
      ok: true,
      message: "Opening TODO\\live-html-smokes\\smoke.html",
      path: "D:\\TOOLSHELF\\modus\\TODO\\live-html-smokes\\smoke.html",
    });
  });

  test("decodes a byte-array shell payload to text", () => {
    const text = "hello\nworld";
    const bytes = [...Buffer.from(text)];
    expect(parseMoveApiResultText(JSON.stringify({ type: "Bash", output: bytes }), true)).toEqual({
      ok: true,
      message: text,
    });
  });
});
