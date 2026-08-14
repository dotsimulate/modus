import { describe, expect, test } from "bun:test";
import {
  extensionSettingScope,
  resolveExtensionSettings,
  type ExtensionSettingSchema,
} from "../client-extensions";

const schema: Record<string, ExtensionSettingSchema> = {
  // Names local hardware, so it is allowed to differ per client.
  micDevice: { type: "string", label: "Microphone" },
  // The harness dials this, so every client must agree on it.
  whisperUrl: { type: "string", label: "Whisper API URL", scope: "global" },
};

describe("extensionSettingScope", () => {
  test("defaults to user, matching plugin settings", () => {
    expect(extensionSettingScope({ type: "string", label: "x" })).toBe("user");
    expect(extensionSettingScope({ type: "string", label: "x", scope: "user" })).toBe("user");
    expect(extensionSettingScope({ type: "string", label: "x", scope: "global" })).toBe("global");
  });
});

describe("resolveExtensionSettings", () => {
  // The defect this whole change exists for: a phone seeds its own user
  // profile, so the merged map carries no whisperUrl, and the value the machine
  // is actually configured with has to come from the shared layers.
  test("a global setting resolves from the shared map when the profile has none", () => {
    const values = resolveExtensionSettings(
      schema,
      { micDevice: "Yeti" },
      { whisperUrl: "http://whisper-box:8080/v1/audio/transcriptions" },
    );
    expect(values.whisperUrl).toBe("http://whisper-box:8080/v1/audio/transcriptions");
    expect(values.micDevice).toBe("Yeti");
  });

  test("a global setting ignores a per-profile value when a shared one exists", () => {
    const values = resolveExtensionSettings(
      schema,
      { whisperUrl: "http://stale-profile:8080/v1/audio/transcriptions" },
      { whisperUrl: "http://whisper-box:8080/v1/audio/transcriptions" },
    );
    expect(values.whisperUrl).toBe("http://whisper-box:8080/v1/audio/transcriptions");
  });

  // Installs that configured the endpoint before it declared a scope keep
  // working, so upgrading does not silently break a desktop that works today.
  test("a global setting falls back to a legacy per-profile value", () => {
    const values = resolveExtensionSettings(
      schema,
      { whisperUrl: "http://legacy:8080/v1/audio/transcriptions" },
      {},
    );
    expect(values.whisperUrl).toBe("http://legacy:8080/v1/audio/transcriptions");
  });

  // A user-scoped setting must NOT read the shared map, or one client's
  // microphone choice would leak onto every other client.
  test("a user setting never reads the shared map", () => {
    const values = resolveExtensionSettings(schema, {}, { micDevice: "SomeoneElsesMic" });
    expect(values.micDevice).toBe(null);
  });

  test("schema defaults still apply when nothing is stored", () => {
    const withDefault: Record<string, ExtensionSettingSchema> = {
      model: { type: "string", label: "Model", default: "whisper-1" },
    };
    expect(resolveExtensionSettings(withDefault, undefined).model).toBe("whisper-1");
  });
});
