/**
 * Subprocess one-shot transport tests — the pure pieces only.
 *
 * The argv builder and output parser are what can be wrong silently; the spawn
 * wrapper is exercised through `model-oneshot`'s injected-completer seam and by
 * a real CLI run, not here. The parser fixture is a verbatim capture from
 * claude CLI 2.1.215 (`claude -p --output-format json --max-turns 1 --tools ""`),
 * so the assertions pin the shape the CLI actually emits, not a guess at it.
 */
import { describe, expect, test } from "bun:test";
import {
  buildOneShotArgv,
  parseCliOneShotOutput,
  pickPrimaryModel,
} from "./claude-cli-oneshot";

// Verbatim capture, 2026-07-30. Note the haiku entry in modelUsage: the CLI
// runs small helper calls alongside the answering model.
const REAL_RESULT = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1263,"duration_api_ms":2266,"ttft_ms":1245,"ttft_stream_ms":1174,"time_to_request_ms":31,"num_turns":1,"result":"pong","stop_reason":"end_turn","session_id":"1e83ba6e-19a8-459e-97b4-d0159ecf1422","total_cost_usd":0.024562,"usage":{"input_tokens":1,"cache_creation_input_tokens":2387,"cache_read_input_tokens":0,"output_tokens":4,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":522,"outputTokens":13,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.000587,"contextWindow":200000,"maxOutputTokens":32000},"claude-opus-4-8[1m]":{"inputTokens":1,"outputTokens":4,"cacheReadInputTokens":0,"cacheCreationInputTokens":2387,"webSearchRequests":0,"costUSD":0.023975,"contextWindow":1000000,"maxOutputTokens":64000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"2344d82e-558d-4c61-922b-d5e3eec5ccf7"}`;

describe("argv builder", () => {
  test("the base argv is print mode, one turn, json result, no tools", () => {
    expect(buildOneShotArgv()).toEqual([
      "-p",
      "--output-format", "json",
      "--max-turns", "1",
      "--tools", "",
    ]);
  });

  test("model, effort, and system prompt file are appended when present", () => {
    const args = buildOneShotArgv({
      model: "claude-haiku-4-5",
      effort: "low",
      systemPromptFile: "C:/tmp/sys.txt",
    });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(args[args.indexOf("--effort") + 1]).toBe("low");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("C:/tmp/sys.txt");
  });

  test('effort "off" is omitted, matching the session provider', () => {
    expect(buildOneShotArgv({ effort: "off" })).not.toContain("--effort");
  });
});

describe("output parser", () => {
  test("extracts text, usage, and the answering model from a real capture", () => {
    const outcome = parseCliOneShotOutput(REAL_RESULT);
    expect(outcome.text).toBe("pong");
    expect(outcome.model).toBe("claude-opus-4-8[1m]");
    expect(outcome.usage).toEqual({
      input: 1,
      output: 4,
      totalTokens: 5,
      costUsd: 0.024562,
    });
  });

  test("scans past noise lines to find the result object", () => {
    const noisy = `some warning\n{"type":"other"}\n${REAL_RESULT}\n`;
    expect(parseCliOneShotOutput(noisy).text).toBe("pong");
  });

  test("an error result becomes a throw carrying the subtype and detail", () => {
    const err = `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"credit balance too low"}`;
    expect(() => parseCliOneShotOutput(err)).toThrow(/error_during_execution/);
    expect(() => parseCliOneShotOutput(err)).toThrow(/credit balance too low/);
  });

  test("is_error wins even when the subtype claims success", () => {
    const lying = `{"type":"result","subtype":"success","is_error":true,"result":"nope"}`;
    expect(() => parseCliOneShotOutput(lying)).toThrow(/nope/);
  });

  test("output with no result object throws rather than returning empty text", () => {
    expect(() => parseCliOneShotOutput("")).toThrow(/no result object/);
    expect(() => parseCliOneShotOutput("plain text, not json")).toThrow(/no result object/);
  });
});

describe("primary model pick", () => {
  test("the answering model beats the helper by cost", () => {
    expect(pickPrimaryModel({
      "helper-haiku": { costUSD: 0.0005, inputTokens: 522, outputTokens: 13 },
      "answering-opus": { costUSD: 0.024, inputTokens: 1, outputTokens: 4 },
    })).toBe("answering-opus");
  });

  test("token volume breaks a zero-cost tie (subscription gateways report no cost)", () => {
    expect(pickPrimaryModel({
      small: { costUSD: 0, inputTokens: 10, outputTokens: 2 },
      big: { costUSD: 0, inputTokens: 400, outputTokens: 90 },
    })).toBe("big");
  });

  test("absent usage yields undefined, not a crash", () => {
    expect(pickPrimaryModel(undefined)).toBeUndefined();
    expect(pickPrimaryModel({})).toBeUndefined();
  });
});
