import { describe, expect, test } from "bun:test";
import {
  mayLoadBackendClientExtensions,
  refreshBackendClientExtensions,
} from "../../ui/src/client-extension-policy";

describe("client extension backend trust policy", () => {
  test("blocks remote backend modules in the native desktop renderer", () => {
    expect(mayLoadBackendClientExtensions("remote", true)).toBe(false);
  });

  test("retains trusted local desktop extension support", () => {
    expect(mayLoadBackendClientExtensions("managed-local", true)).toBe(true);
    expect(mayLoadBackendClientExtensions("external-local", true)).toBe(true);
  });

  test("does not redefine the ordinary browser trusted-code model", () => {
    expect(mayLoadBackendClientExtensions("browser", false)).toBe(true);
    expect(mayLoadBackendClientExtensions("remote", false)).toBe(true);
  });

  test("never requests a hostile remote manifest from the native renderer", async () => {
    let listed = 0;
    let loaded = 0;
    let unloaded = 0;
    const result = await refreshBackendClientExtensions({
      targetMode: "remote",
      nativeDesktop: true,
      list: async () => {
        listed++;
        return [{ id: "hostile", enabled: true, moduleUrl: "https://hostile.invalid/code.js", settingsValues: {} }];
      },
      load: async () => { loaded++; },
      unload: async () => { unloaded++; },
    });

    expect(result).toBe("blocked");
    expect(listed).toBe(0);
    expect(loaded).toBe(0);
    expect(unloaded).toBe(1);
  });
});
