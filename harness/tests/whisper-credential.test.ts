import { describe, expect, test } from "bun:test";
import { isLoopbackHostname, resolveWhisperCredential } from "../whisper-credential";

const SECRETS: Record<string, string> = { OPENAI_API_KEY: "sk-test-value" };
const lookup = (name: string) => SECRETS[name];

describe("whisper upstream credential policy", () => {
  test("attaches nothing when no secret is named", () => {
    expect(resolveWhisperCredential({
      targetUrl: "http://127.0.0.1:8080/v1/audio/transcriptions",
      lookup,
    })).toEqual({ kind: "none" });

    expect(resolveWhisperCredential({
      secretName: "   ",
      targetUrl: "https://api.openai.com/v1/audio/transcriptions",
      lookup,
    })).toEqual({ kind: "none" });
  });

  test("attaches a bearer token for an https endpoint", () => {
    expect(resolveWhisperCredential({
      secretName: "OPENAI_API_KEY",
      targetUrl: "https://api.openai.com/v1/audio/transcriptions",
      lookup,
    })).toEqual({ kind: "attach", authorization: "Bearer sk-test-value" });
  });

  test("attaches over plain http only on loopback", () => {
    expect(resolveWhisperCredential({
      secretName: "OPENAI_API_KEY",
      targetUrl: "http://127.0.0.1:8080/v1/audio/transcriptions",
      lookup,
    })).toEqual({ kind: "attach", authorization: "Bearer sk-test-value" });

    expect(resolveWhisperCredential({
      secretName: "OPENAI_API_KEY",
      targetUrl: "http://localhost:8080/v1/audio/transcriptions",
      lookup,
    })).toEqual({ kind: "attach", authorization: "Bearer sk-test-value" });
  });

  test("refuses to put the key on the wire in the clear", () => {
    // The endpoint URL is user-supplied via X-Whisper-Url, so a mistyped or
    // hostile value must not be able to carry the credential off-machine
    // unencrypted.
    const decision = resolveWhisperCredential({
      secretName: "OPENAI_API_KEY",
      targetUrl: "http://whisper.example.com/v1/audio/transcriptions",
      lookup,
    });
    expect(decision.kind).toBe("reject");
    expect(JSON.stringify(decision)).not.toContain("sk-test-value");
  });

  test("reports an unconfigured secret instead of silently sending nothing", () => {
    expect(resolveWhisperCredential({
      secretName: "MISSING_KEY",
      targetUrl: "https://api.openai.com/v1/audio/transcriptions",
      lookup,
    })).toEqual({
      kind: "reject",
      error: 'whisper secret "MISSING_KEY" is not configured',
    });
  });

  test("rejects an unparseable target rather than guessing", () => {
    expect(resolveWhisperCredential({
      secretName: "OPENAI_API_KEY",
      targetUrl: "not a url",
      lookup,
    })).toEqual({ kind: "reject", error: "invalid whisper url" });
  });

  test("recognizes loopback forms without over-matching", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.1.2.3")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    // A hostname that merely starts with the same digits is not loopback.
    expect(isLoopbackHostname("127.evil.com")).toBe(false);
    expect(isLoopbackHostname("localhost.evil.com")).toBe(false);
    expect(isLoopbackHostname("10.0.0.1")).toBe(false);
  });
});
