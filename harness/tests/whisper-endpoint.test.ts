import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WHISPER_URL,
  describeWhisperFetchFailure,
  resolveWhisperEndpoint,
} from "../whisper-endpoint";

describe("resolveWhisperEndpoint", () => {
  test("prefers the shared setting over every other source", () => {
    const result = resolveWhisperEndpoint({
      sharedSetting: "http://whisper-box:8080/v1/audio/transcriptions",
      profileSetting: "http://stale-profile:8080/v1/audio/transcriptions",
      env: "http://env:8080/v1/audio/transcriptions",
    });
    expect(result).toMatchObject({
      kind: "ok",
      url: "http://whisper-box:8080/v1/audio/transcriptions",
      source: "setting",
      configured: true,
    });
  });

  // The whole point of the change: a client that never opened the settings form
  // must still resolve the endpoint the machine is configured with, because the
  // backend is what dials it.
  test("resolves the shared setting even when the caller's profile has none", () => {
    const result = resolveWhisperEndpoint({
      sharedSetting: "http://whisper-box:8080/v1/audio/transcriptions",
      profileSetting: undefined,
    });
    expect(result).toMatchObject({ kind: "ok", source: "setting", configured: true });
  });

  test("falls back to a profile value stored before the setting was scoped", () => {
    const result = resolveWhisperEndpoint({
      profileSetting: "http://legacy:8080/v1/audio/transcriptions",
      env: "http://env:8080/v1/audio/transcriptions",
    });
    expect(result).toMatchObject({
      kind: "ok",
      url: "http://legacy:8080/v1/audio/transcriptions",
      source: "legacy-profile-setting",
      configured: true,
    });
  });

  test("falls back to the environment before the hardcoded default", () => {
    const result = resolveWhisperEndpoint({ env: "http://env:8080/v1/audio/transcriptions" });
    expect(result).toMatchObject({ kind: "ok", source: "env", configured: true });
  });

  test("blank and whitespace values are not configuration", () => {
    const result = resolveWhisperEndpoint({ sharedSetting: "   ", profileSetting: "" });
    expect(result).toMatchObject({
      kind: "ok",
      url: DEFAULT_WHISPER_URL,
      source: "default",
      configured: false,
    });
  });

  // configured:false is what separates "your whisper server is down" from
  // "nothing was ever configured", so it has to survive to the caller.
  test("the loopback default is reported as unconfigured", () => {
    const result = resolveWhisperEndpoint({});
    expect(result).toMatchObject({ kind: "ok", url: DEFAULT_WHISPER_URL, configured: false });
  });

  test("rejects a non-http protocol rather than dialling it", () => {
    const result = resolveWhisperEndpoint({ sharedSetting: "file:///etc/passwd" });
    expect(result.kind).toBe("invalid");
  });

  test("rejects an unparseable url", () => {
    const result = resolveWhisperEndpoint({ sharedSetting: "not a url" });
    expect(result.kind).toBe("invalid");
  });
});

describe("describeWhisperFetchFailure", () => {
  test("an unreachable default names the missing configuration, not a failure", () => {
    const resolution = resolveWhisperEndpoint({});
    if (resolution.kind !== "ok") throw new Error("expected ok");
    const message = describeWhisperFetchFailure(resolution, "ConnectionRefused");
    expect(message).toContain("no whisper endpoint is configured");
    expect(message).toContain(DEFAULT_WHISPER_URL);
    // The old message was a bare "whisper transcription failed", which sent the
    // user looking at their microphone and their tunnel for days.
    expect(message).not.toContain("transcription failed");
  });

  test("an unreachable configured endpoint names the url that was tried", () => {
    const resolution = resolveWhisperEndpoint({
      sharedSetting: "http://whisper-box:8080/v1/audio/transcriptions",
    });
    if (resolution.kind !== "ok") throw new Error("expected ok");
    const message = describeWhisperFetchFailure(resolution, "ConnectionRefused");
    expect(message).toContain("http://whisper-box:8080/v1/audio/transcriptions");
    expect(message).toContain("ConnectionRefused");
    expect(message).not.toContain("no whisper endpoint is configured");
  });
});
